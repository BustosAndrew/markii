import Link from "next/link";
import { Suspense } from "react";
import { getAnalyticsOverview } from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DateRangeFilters } from "@/components/ui/date-range-filters";
import { BarChart, DaySparkBars } from "@/components/ui/charts";
import { FetchError } from "@/components/dashboard/fetch-error";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const from = firstParam(sp.from);
  const to = firstParam(sp.to);

  const { data, error } = await loadOrError(() =>
    getAnalyticsOverview({ q, from, to }),
  );

  const busiest = data?.byDay.length
    ? data.byDay.reduce((best, d) => (d.count > best.count ? d : best))
    : null;
  const topAgentShare =
    data && data.total > 0 && data.byAgent[0]
      ? Math.round((data.byAgent[0].count / data.total) * 100)
      : 0;

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Agent traffic across all websites."
      />

      <Suspense fallback={null}>
        <DateRangeFilters searchPlaceholder="Search sites…" />
      </Suspense>

      {error ? (
        <FetchError title="Analytics unavailable" message={error} />
      ) : null}

      {!error && data ? (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <Stat label="Agent hits in range" value={data.total.toLocaleString()} />
            <Stat
              label="Busiest day"
              value={busiest ? formatDay(busiest.date) : "—"}
              detail={
                busiest
                  ? `${busiest.count.toLocaleString()} agent hits`
                  : "no traffic in range"
              }
            />
            <Stat
              label="Top agent"
              value={data.byAgent[0]?.agentName ?? "—"}
              detail={
                data.byAgent[0]
                  ? `${data.byAgent[0].count.toLocaleString()} hits · ${topAgentShare}% of traffic`
                  : "no traffic in range"
              }
            />
          </div>

          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] lg:col-span-2">
              <h2 className="mb-4 text-sm font-medium text-foreground">
                Traffic by day
              </h2>
              <DaySparkBars data={data.byDay} />
            </section>
            <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
              <h2 className="mb-4 text-sm font-medium text-foreground">
                Which agents are visiting
              </h2>
              <BarChart
                data={data.byAgent.map((a) => ({
                  label: a.agentName,
                  count: a.count,
                }))}
              />
            </section>
          </div>

          {data.sites.length === 0 ? (
            <EmptyState
              title="No traffic yet"
              description="Site-level agent traffic will appear here once crawlers hit storefronts."
              action={
                <ButtonLink href="/dashboard/websites">View websites</ButtonLink>
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-surface-elevated text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Site</th>
                    <th className="px-4 py-3 font-medium">Total</th>
                    <th className="px-4 py-3 font-medium">Last 7d</th>
                    <th className="px-4 py-3 font-medium">Top agent</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sites.map((site) => (
                    <tr
                      key={site.siteId}
                      className="border-t border-border hover:bg-table-hover"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/dashboard/analytics/${site.siteSlug}`}
                          className="font-medium text-foreground hover:text-brand"
                        >
                          {site.siteName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 tabular-nums">{site.total}</td>
                      <td className="px-4 py-3 tabular-nums text-muted">
                        {site.last7d}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {site.topAgent ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function formatDay(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-2 truncate text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
      {detail ? <p className="mt-1 text-sm text-muted">{detail}</p> : null}
    </div>
  );
}
