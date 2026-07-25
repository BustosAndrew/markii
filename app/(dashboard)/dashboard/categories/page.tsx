import Link from "next/link";
import { Suspense } from "react";
import { listCategories } from "@/lib/api/categories";
import { listSites } from "@/lib/api/sites";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { ListFilters } from "@/components/ui/list-filters";
import { FetchError } from "@/components/dashboard/fetch-error";

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;
  const enabledRaw = firstParam(sp.enabled);
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const sitesResult = await loadOrError(() =>
    listSites({ limit: 100, sort: "name" }, { cache: "no-store" }),
  );
  const sites = sitesResult.data?.items ?? [];

  const { data, error } = await loadOrError(() =>
    listCategories(
      {
        q,
        siteId: Number.isFinite(siteId) ? siteId : undefined,
        enabled:
          enabledRaw === "true"
            ? true
            : enabledRaw === "false"
              ? false
              : undefined,
        page,
        limit,
      },
      { cache: "no-store" },
    ),
  );

  return (
    <div>
      <PageHeader
        title="Categories"
        description="Organize products across sites."
        actions={
          <ButtonLink href="/dashboard/categories/new">New category</ButtonLink>
        }
      />

      <Suspense fallback={null}>
        <ListFilters
          searchPlaceholder="Search categories…"
          filters={[
            {
              key: "siteId",
              label: "All sites",
              options: sites.map((s) => ({
                value: String(s.id),
                label: s.name,
              })),
            },
            {
              key: "enabled",
              label: "All availability",
              options: [
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ],
            },
          ]}
        />
      </Suspense>

      {error ? (
        <FetchError title="Categories unavailable" message={error} />
      ) : null}

      {!error && data && data.items.length === 0 ? (
        <EmptyState
          title="No categories"
          description="Create a category to organize products."
          action={
            <ButtonLink href="/dashboard/categories/new">
              New category
            </ButtonLink>
          }
        />
      ) : null}

      {!error && data && data.items.length > 0 ? (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-surface-elevated text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Site</th>
                  <th className="px-4 py-3 font-medium">Parent</th>
                  <th className="px-4 py-3 font-medium">Products</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((category) => (
                  <tr
                    key={category.id}
                    className="border-t border-border hover:bg-table-hover"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/categories/${category.slug}?siteId=${category.siteId}`}
                        className="font-medium text-foreground hover:text-brand"
                      >
                        {category.name}
                      </Link>
                      <p className="font-mono text-xs text-muted">
                        {category.slug}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {category.site?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {category.parent?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {category.productCount}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={category.enabled ? "success" : "neutral"}>
                        {category.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Suspense fallback={null}>
            <Pagination page={data.page} limit={data.limit} total={data.total} />
          </Suspense>
        </>
      ) : null}
    </div>
  );
}
