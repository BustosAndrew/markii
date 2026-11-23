import Link from "next/link";
import { getMe, getSite, listSiteForms } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteCms } from "@/lib/api/org";
import { FetchError } from "@/components/dashboard/fetch-error";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export default async function WebsiteFormsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [siteResult, formsResult, me] = await Promise.all([
    loadOrError(() => getSite(slug)),
    loadOrError(() => listSiteForms(slug)),
    loadOrError(() => getMe()),
  ]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Forms" description={`/${slug}`} />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;
  const canWrite = canWriteCms(me.data?.role);
  const items = formsResult.data?.items ?? [];

  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader
        title="Forms"
        description="Contact and enquiry forms. Each one is live at /forms/{handle} as soon as it exists."
        actions={
          <>
            <ButtonLink href={`/dashboard/websites/${site.slug}/forms/submissions`} variant="secondary">
              Submissions
            </ButtonLink>
            <ButtonLink href={`/dashboard/websites/${site.slug}/forms/blocklist`} variant="secondary">
              Blocklist
            </ButtonLink>
            {canWrite ? <ButtonLink href={`/dashboard/websites/${site.slug}/forms/new`}>New form</ButtonLink> : null}
          </>
        }
      />

      {!formsResult.data ? (
        <FetchError message={formsResult.error ?? "Forms could not be loaded."} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No forms yet"
          description="Create a form, then place it on a page with the Form block in the design editor."
          action={canWrite ? <ButtonLink href={`/dashboard/websites/${site.slug}/forms/new`}>New form</ButtonLink> : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-medium">Form</th>
                <th className="px-4 py-3 font-medium">Address</th>
                <th className="px-4 py-3 font-medium">Submissions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((form) => (
                <tr key={form.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/websites/${site.slug}/forms/${form.id}`} className="font-medium text-foreground hover:text-brand">
                      {form.name}
                    </Link>
                    <div className="font-mono text-xs text-muted">{form.handle}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-muted">{form.path}</td>
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/websites/${site.slug}/forms/submissions?form=${encodeURIComponent(form.handle)}`} className="text-foreground hover:text-brand">
                      {form.submissions}
                    </Link>
                    {form.submissions === 0 ? <Badge variant="neutral" className="ml-2">None</Badge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
