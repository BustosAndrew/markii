import Link from "next/link";
import { Suspense } from "react";
import { getSiteAnalytics } from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { DateRangeFilters } from "@/components/ui/date-range-filters";
import { BarChart, DaySparkBars } from "@/components/ui/charts";
import { FetchError } from "@/components/dashboard/fetch-error";

export default async function AnalyticsDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const from = firstParam(sp.from);
  const to = firstParam(sp.to);
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const { data, error } = await loadOrError(() =>
    getSiteAnalytics(
      slug,
      { q, from, to, page, limit }),
  );

  if (error || !data) {
    return (
      <div>
        <PageHeader title="Site analytics" description={slug} />
        <FetchError
          title="Analytics unavailable"
          message={error ?? "Not found"}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={data.site.name}
        description="Which products agents viewed, and who crawled them."
      />

      <Suspense fallback={null}>
        <DateRangeFilters searchPlaceholder="Search products…" />
      </Suspense>

      <div className="mb-6 rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <p className="text-sm text-muted">Total hits</p>
        <p className="mt-2 text-3xl font-semibold tracking-tight">{data.total}</p>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium text-foreground">
            Traffic by day
          </h2>
          <DaySparkBars data={data.byDay} />
        </section>
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-medium text-foreground">
            Agents
          </h2>
          <BarChart
            data={data.byAgent.map((a) => ({
              label: a.agentName,
              count: a.count,
            }))}
          />
        </section>
      </div>

      {data.products.items.length === 0 ? (
        <EmptyState
          title="No product views"
          description="Product-level agent views will show here once traffic is logged."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-surface-elevated text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Views</th>
                  <th className="px-4 py-3 font-medium">Agents</th>
                </tr>
              </thead>
              <tbody>
                {data.products.items.map((product) => (
                  <tr
                    key={product.productId}
                    className="border-t border-border hover:bg-table-hover"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/products/${product.slug}?siteId=${data.site.id}`}
                        className="font-medium text-foreground hover:text-brand"
                      >
                        {product.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{product.views}</td>
                    <td className="px-4 py-3 text-muted">
                      {product.agents
                        .map((a) => `${a.agentName} (${a.views})`)
                        .join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Suspense fallback={null}>
            <Pagination
              page={data.products.page}
              limit={data.products.limit}
              total={data.products.total}
            />
          </Suspense>
        </>
      )}
    </div>
  );
}
