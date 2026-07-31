import Link from "next/link";
import { Suspense } from "react";
import { getFinancesOverview } from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { OrdersSubnav } from "@/components/dashboard/orders-subnav";
import { FetchError } from "@/components/dashboard/fetch-error";
import { DateRangeFilters } from "@/components/ui/date-range-filters";
import { EmptyState } from "@/components/ui/empty-state";
import { MoneyText } from "@/components/ui/money-text";
import { PageHeader } from "@/components/ui/page-header";
import { ButtonLink } from "@/components/ui/button";

export default async function SettlementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const from = firstParam(sp.from);
  const to = firstParam(sp.to);

  const { data, error } = await loadOrError(() => getFinancesOverview({ q, from, to }));

  return (
    <div>
      <PageHeader
        title="Settlements"
        description="Balances across sites and payment rails while the expanded orders API is still planned."
      />
      <OrdersSubnav />

      <Suspense fallback={null}>
        <DateRangeFilters searchPlaceholder="Search sites…" />
      </Suspense>

      {error ? <FetchError title="Settlements unavailable" message={error} /> : null}

      {!error && data ? (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Total balance" value={<MoneyText cents={data.totalBalanceCents} />} />
            <Stat
              label="x402"
              value={<MoneyText cents={data.x402BalanceCents} currency="USDC" />}
            />
            <Stat label="Fiat" value={<MoneyText cents={data.fiatBalanceCents} />} />
            <Stat label="Orders" value={String(data.orderCount)} />
          </div>

          {data.sites.length === 0 ? (
            <EmptyState
              title="No settlement data"
              description="Balances appear once sites have orders or seed data."
              action={<ButtonLink href="/dashboard/websites/new">Create website</ButtonLink>}
            />
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-surface-elevated text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Site</th>
                    <th className="px-4 py-3 font-medium">Balance</th>
                    <th className="px-4 py-3 font-medium">x402</th>
                    <th className="px-4 py-3 font-medium">Fiat</th>
                    <th className="px-4 py-3 font-medium">Orders</th>
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
                          href={`/dashboard/orders/settlements/${site.siteSlug}`}
                          className="font-medium text-foreground hover:text-brand"
                        >
                          {site.siteName}
                        </Link>
                        {site.pendingCount > 0 ? (
                          <p className="text-xs text-warning-text">
                            {site.pendingCount} pending
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        <MoneyText cents={site.balanceCents} />
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted">
                        <MoneyText cents={site.x402Cents} currency="USDC" />
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted">
                        <MoneyText cents={site.fiatCents} />
                      </td>
                      <td className="px-4 py-3 tabular-nums">{site.orderCount}</td>
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

function Stat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
    </div>
  );
}
