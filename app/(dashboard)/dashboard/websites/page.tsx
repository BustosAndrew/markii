import { Suspense } from "react";
import { listSites } from "@/lib/api/sites";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import type { SiteStatus } from "@/lib/api/types";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { ListFilters } from "@/components/ui/list-filters";
import { FetchError } from "@/components/dashboard/fetch-error";
import { SiteCard } from "@/components/dashboard/site-card";

export default async function WebsitesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const status = firstParam(sp.status) as SiteStatus | undefined;
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const { data, error } = await loadOrError(() =>
    listSites(
      {
        q,
        status:
          status === "draft" || status === "live" || status === "paused"
            ? status
            : undefined,
        page,
        limit,
        sort: "-createdAt",
      },
      { cache: "no-store" },
    ),
  );

  return (
    <div>
      <PageHeader
        title="Websites"
        description="Agent storefronts across your Markii account."
        actions={
          <ButtonLink href="/dashboard/websites/new">New website</ButtonLink>
        }
      />

      <Suspense fallback={null}>
        <ListFilters
          searchPlaceholder="Search websites…"
          filters={[
            {
              key: "status",
              label: "All statuses",
              options: [
                { value: "live", label: "Live" },
                { value: "draft", label: "Draft" },
                { value: "paused", label: "Paused" },
              ],
            },
          ]}
        />
      </Suspense>

      {error ? <FetchError title="Websites unavailable" message={error} /> : null}

      {!error && data && data.items.length === 0 ? (
        <EmptyState
          title="No websites yet"
          description="Create a site to import a catalog and deploy for agents."
          action={
            <ButtonLink href="/dashboard/websites/new">Create website</ButtonLink>
          }
        />
      ) : null}

      {!error && data && data.items.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.items.map((site) => (
              <SiteCard key={site.id} site={site} />
            ))}
            <ButtonLink
              href="/dashboard/websites/new"
              variant="secondary"
              className="min-h-[160px] flex-col items-start justify-between rounded-[var(--radius-card)] border-dashed px-5 py-5 text-left font-normal"
            >
              <span className="text-sm text-muted">Get started</span>
              <span>
                <span className="block text-lg font-semibold text-foreground">
                  Create a website
                </span>
                <span className="mt-1 block text-sm text-muted">
                  Import a catalog and go live.
                </span>
              </span>
            </ButtonLink>
          </div>
          <Suspense fallback={null}>
            <Pagination page={data.page} limit={data.limit} total={data.total} />
          </Suspense>
        </>
      ) : null}
    </div>
  );
}
