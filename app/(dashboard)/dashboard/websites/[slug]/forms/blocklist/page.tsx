import { getMe, getSite, listSiteFormBlocklist } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteCommerce } from "@/lib/api/org";
import { FetchError } from "@/components/dashboard/fetch-error";
import { FormBlocklistPanel } from "@/components/dashboard/form-blocklist";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";

export default async function FormBlocklistPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [siteResult, listResult, me] = await Promise.all([
    loadOrError(() => getSite(slug)),
    loadOrError(() => listSiteFormBlocklist(slug)),
    loadOrError(() => getMe()),
  ]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Blocklist" />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;

  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader
        title="Form blocklist"
        description="Blocked emails and domains are refused before a submission is stored. @example.com includes subdomains."
        actions={
          <ButtonLink href={`/dashboard/websites/${site.slug}/forms/submissions`} variant="secondary">
            Submissions
          </ButtonLink>
        }
      />
      {!listResult.data ? (
        <FetchError message={listResult.error ?? "The blocklist could not be loaded."} />
      ) : (
        <FormBlocklistPanel siteId={site.id} items={listResult.data.items} canWrite={canWriteCommerce(me.data?.role)} />
      )}
    </div>
  );
}
