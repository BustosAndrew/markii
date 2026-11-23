import { getMe, getSite, listSiteRedirects } from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { canWriteCms } from "@/lib/api/org";
import { FetchError } from "@/components/dashboard/fetch-error";
import { RedirectsPanel } from "@/components/dashboard/redirects-panel";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";

export default async function RedirectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit, 50);
  const offset = (page - 1) * limit;

  const [siteResult, listResult, me] = await Promise.all([
    loadOrError(() => getSite(slug)),
    loadOrError(() => listSiteRedirects(slug, { q, limit, offset })),
    loadOrError(() => getMe()),
  ]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Redirects" />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;
  const data = listResult.data;
  const canWrite = canWriteCms(me.data?.role);

  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader
        title="Redirects"
        description="Sends an old link to its new place. Only used when nothing on your store answers that link — it never hides a live page. Takes effect as soon as you save — no publish needed."
      />
      <ListFilters searchPlaceholder="Search old or new links…" />
      {!data ? (
        <FetchError message={listResult.error ?? "Redirects could not be loaded."} />
      ) : data.items.length === 0 && !q && !canWrite ? (
        <EmptyState title="No redirects" description="Old links from a previous store land here once you add them." />
      ) : data ? (
        <>
          {data.items.length === 0 && q ? (
            <p className="mb-4 text-sm text-muted">No redirects match that search.</p>
          ) : null}
          <RedirectsPanel siteId={site.id} items={data.items} canWrite={canWrite} />
          <Pagination page={page} limit={limit} total={data.total} />
        </>
      ) : null}
    </div>
  );
}
