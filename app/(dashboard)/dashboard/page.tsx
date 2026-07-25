import Link from "next/link";
import { getOverview } from "@/lib/api/server";
import { ApiClientError } from "@/lib/api/types";
import { ButtonLink } from "@/components/ui/button";
import { BarChart, DaySparkBars, Sparkline } from "@/components/ui/charts";
import { EmptyState } from "@/components/ui/empty-state";
import { MoneyText } from "@/components/ui/money-text";
import { PageHeader } from "@/components/ui/page-header";
import { OverviewError } from "./overview-error";

export default async function DashboardOverviewPage() {
  let data: Awaited<ReturnType<typeof getOverview>> | null = null;
  let errorMessage: string | null = null;

  try {
    data = await getOverview();
  } catch (err) {
    if (err instanceof ApiClientError) {
      errorMessage = err.message;
    } else if (err instanceof Error) {
      errorMessage = err.message;
    } else {
      errorMessage = "Could not reach the overview API.";
    }
  }

  const sitesWithBalance =
    data?.finances.bySite.filter((s) => s.balanceCents > 0) ?? [];
  const topBalanceSites = [...sitesWithBalance]
    .sort((a, b) => b.balanceCents - a.balanceCents)
    .slice(0, 5);

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Sites, agent traffic, and balances across your Markii stores."
        actions={
          <ButtonLink href="/dashboard/websites/new">New website</ButtonLink>
        }
      />

      {errorMessage ? <OverviewError message={errorMessage} /> : null}

      {!errorMessage && data && data.sites.total === 0 ? (
        <EmptyState
          title="No websites yet"
          description="Create a site to import a catalog and deploy an agent-readable storefront."
          action={
            <ButtonLink href="/dashboard/websites/new">
              Create website
            </ButtonLink>
          }
        />
      ) : null}

      {!errorMessage && data && data.sites.total > 0 ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Sites"
              value={String(data.sites.total)}
              detail={`${data.sites.live} live · ${data.sites.draft} draft · ${data.sites.paused} paused`}
              href="/dashboard/websites"
            />
            <StatTile
              label="Agent traffic"
              value={data.traffic.total.toLocaleString()}
              detail={`${data.traffic.last7d.toLocaleString()} in the last 7 days`}
              href="/dashboard/analytics"
              trend={<Sparkline data={data.traffic.byDay} />}
            />
            <StatTile
              label="Total balance"
              value={<MoneyText cents={data.finances.totalBalanceCents} />}
              detail={`${data.finances.orderCount} settled ${
                data.finances.orderCount === 1 ? "order" : "orders"
              }`}
              href="/dashboard/finances"
            />
            <CreateSiteCard />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] lg:col-span-2">
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  Agent traffic, last 14 days
                </h2>
                <Link
                  href="/dashboard/analytics"
                  className="text-sm text-muted hover:text-brand"
                >
                  All analytics →
                </Link>
              </div>
              <DaySparkBars data={data.traffic.byDay} />
            </section>

            <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
              <h2 className="mb-4 text-sm font-medium text-foreground">
                Which agents are visiting
              </h2>
              <BarChart
                data={data.traffic.topAgents.map((a) => ({
                  label: a.agentName,
                  count: a.count,
                }))}
                emptyLabel="No agent traffic recorded yet."
              />
            </section>
          </div>

          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-foreground">
                Balance by site
              </h2>
              <Link
                href="/dashboard/finances"
                className="text-sm text-muted hover:text-brand"
              >
                All finances →
              </Link>
            </div>
            {topBalanceSites.length === 0 ? (
              <p className="text-sm text-muted">
                No settled orders yet. Balances appear here once an agent
                completes an x402 checkout.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {topBalanceSites.map((site) => (
                  <li key={site.siteId}>
                    <Link
                      href={`/dashboard/finances/${site.siteSlug}`}
                      className="-mx-2 flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-2 py-2.5 hover:bg-hover-soft"
                    >
                      <span className="truncate text-sm font-medium text-foreground">
                        {site.siteName}
                      </span>
                      <span className="shrink-0 text-sm tabular-nums text-foreground">
                        <MoneyText cents={site.balanceCents} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function StatTile({
  label,
  value,
  detail,
  href,
  trend,
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  href: string;
  trend?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-colors hover:border-brand/30 hover:bg-hover-soft"
    >
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
      {trend ? <div className="mt-3">{trend}</div> : null}
      {/* pinned to the bottom so detail lines align across tiles with and without a trend */}
      <p className="mt-auto pt-2 text-sm text-muted">{detail}</p>
    </Link>
  );
}

function CreateSiteCard() {
  return (
    <Link
      href="/dashboard/websites/new"
      className="flex flex-col justify-between rounded-[var(--radius-card)] border border-dashed border-border bg-surface-elevated p-5 transition-colors hover:border-brand/40 hover:bg-hover-soft"
    >
      <p className="text-sm text-muted">Get started</p>
      <div>
        <p className="text-lg font-semibold tracking-tight text-foreground">
          Create a website
        </p>
        <p className="mt-1 text-sm text-muted">
          Import a catalog and deploy for agents.
        </p>
      </div>
    </Link>
  );
}
