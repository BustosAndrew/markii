import { getMe, getSite, listSiteFormSubmissions } from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { canWriteCommerce } from "@/lib/api/org";
import { FetchError } from "@/components/dashboard/fetch-error";
import { FormSubmissionsList } from "@/components/dashboard/form-submissions";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";

export default async function FormSubmissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const form = firstParam(sp.form);
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit, 50);
  const offset = (page - 1) * limit;

  const [siteResult, listResult, me] = await Promise.all([
    loadOrError(() => getSite(slug)),
    loadOrError(() => listSiteFormSubmissions(slug, { q, form, limit, offset })),
    loadOrError(() => getMe()),
  ]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Submissions" />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;
  const canWrite = canWriteCommerce(me.data?.role);
  const data = listResult.data;

  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader
        title="Form submissions"
        description="Kept permanently. Delete one only for an erasure request."
        actions={
          <ButtonLink href={`/dashboard/websites/${site.slug}/forms/blocklist`} variant="secondary">
            Blocklist
          </ButtonLink>
        }
      />
      <ListFilters
        searchPlaceholder="Search answers or email…"
        textFilters={[{ key: "form", label: "Form handle", placeholder: "contact" }]}
      />
      {!data ? (
        <FetchError message={listResult.error ?? "Submissions could not be loaded."} />
      ) : data.items.length === 0 ? (
        <EmptyState title="No submissions" description="When a shopper sends a form, it lands here." />
      ) : (
        <>
          <FormSubmissionsList items={data.items} canWrite={canWrite} siteId={site.id} />
          <Pagination page={page} limit={limit} total={data.total} />
        </>
      )}
    </div>
  );
}
