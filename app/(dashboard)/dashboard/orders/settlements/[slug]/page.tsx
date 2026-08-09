import { Suspense } from "react";
import { siteFinancesExportUrl } from "@/lib/api/finances";
import { getSiteFinances } from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import type { Order } from "@/lib/api/types";
import { OrdersSubnav } from "@/components/dashboard/orders-subnav";
import { FinancesDetailFilters } from "@/components/dashboard/finances-detail-filters";
import { FetchError } from "@/components/dashboard/fetch-error";
import { TransactionsTable } from "@/components/dashboard/transactions-table";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { MoneyText } from "@/components/ui/money-text";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";

export default async function SettlementDetailPage({
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
  const statusRaw = firstParam(sp.status);
  const status =
    statusRaw === "pending" ||
    statusRaw === "success" ||
    statusRaw === "cancel" ||
    statusRaw === "failed"
      ? (statusRaw as Order["status"])
      : undefined;
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const { data, error } = await loadOrError(() =>
    getSiteFinances(slug, { q, from, to, status, page, limit }),
  );

  if (error || !data) {
    return (
      <div>
        <PageHeader title="Settlement detail" description={slug} />
        <OrdersSubnav />
        <FetchError title="Settlements unavailable" message={error ?? "Not found"} />
      </div>
    );
  }

  const exportHref = siteFinancesExportUrl(slug, { q, from, to, status });

  return (
    <div>
      <PageHeader
        title={data.site.name}
        description="Orders, sales volume by rail, and CSV export."
        actions={
          <ButtonLink href={exportHref} variant="secondary">
            Export CSV
          </ButtonLink>
        }
      />
      <OrdersSubnav />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Total sales" value={<MoneyText cents={data.balance.totalCents} />} />
        <Stat
          label="x402"
          value={<MoneyText cents={data.balance.x402Cents} currency="USDC" />}
        />
        <Stat label="Card / fiat" value={<MoneyText cents={data.balance.fiatCents} />} />
      </div>

      <Suspense fallback={null}>
        <FinancesDetailFilters />
      </Suspense>

      {data.transactions.items.length === 0 ? (
        <EmptyState
          title="No transactions"
          description="Orders will show here once agents check out or seed data loads."
        />
      ) : (
        <>
          <TransactionsTable orders={data.transactions.items} />
          <Suspense fallback={null}>
            <Pagination
              page={data.transactions.page}
              limit={data.transactions.limit}
              total={data.transactions.total}
            />
          </Suspense>
        </>
      )}
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
