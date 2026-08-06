import Link from "next/link";
import { FetchError } from "@/components/dashboard/fetch-error";
import { OrdersSubnav } from "@/components/dashboard/orders-subnav";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { formatMinor } from "@/lib/api/money";
import { ordersExportUrl, type OrderListItem, type OrderTotals } from "@/lib/api/orders";
import { listOrders, listSites } from "@/lib/api/server";
import type { Order } from "@/lib/api/types";

/**
 * `/dashboard/orders` (§13).
 *
 * **Money is formatted from each order's own currency**, not the org's (D31).
 * A store can sell in USD and USDC, and the row is the one place the actual
 * denomination is known — the customers list uses the org currency because the
 * figure there is an aggregate, which is a different question.
 *
 * Operational controls are deliberately absent. Refund, cancel, and fulfill are
 * registry actions (§18.7) invoked through `POST /api/actions/:id`; putting a
 * button here that called a route directly is the bolt-on §22 exists to prevent.
 */

const PAYMENT_LABELS: Record<Order["financialStatus"], string> = {
  pending: "Unpaid",
  paid: "Paid",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  voided: "Voided",
};

const PAYMENT_VARIANTS: Record<Order["financialStatus"], "success" | "warning" | "neutral"> = {
  pending: "neutral",
  paid: "success",
  partially_refunded: "warning",
  refunded: "warning",
  voided: "neutral",
};

const FULFILLMENT_LABELS: Record<Order["fulfillmentStatus"], string> = {
  unfulfilled: "Unfulfilled",
  partially_fulfilled: "Partly shipped",
  fulfilled: "Fulfilled",
  /** Digital and membership orders — nothing to ship, which is not a backlog. */
  not_required: "No shipping",
};

const FULFILLMENT_VARIANTS: Record<
  Order["fulfillmentStatus"],
  "success" | "warning" | "neutral"
> = {
  unfulfilled: "neutral",
  partially_fulfilled: "warning",
  fulfilled: "success",
  not_required: "neutral",
};

const STATUS_FILTER = [
  { value: "success", label: "Completed" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "cancel", label: "Cancelled" },
];

/**
 * One tile group per currency, because that is how the API reports it and how
 * money works — a store selling in USDC and USD has two totals, and adding them
 * produces a number that is not money in either (D31).
 */
function Totals({ totals }: { totals: OrderTotals }) {
  if (totals.byCurrency.length === 0) return null;
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {totals.byCurrency.map((c) => (
        <div
          key={c.currency}
          className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-sm)]"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              {c.currency}
            </span>
            <span className="text-xs text-muted">
              {c.paidOrderCount} of {c.orderCount} paid
            </span>
          </div>
          <div className="mt-2 text-xl font-semibold tabular-nums text-foreground">
            {formatMinor(c.netMinor, c.currency)}
          </div>
          <div className="mt-1 text-xs text-muted">
            {/*
              Gross counts completed orders only — a pending or failed payment is
              a request, not a receipt, and folding it in would inflate revenue.
            */}
            {formatMinor(c.grossMinor, c.currency)} gross ·{" "}
            {formatMinor(c.refundedMinor, c.currency)} refunded
          </div>
        </div>
      ))}
    </div>
  );
}

function OrderRow({ order }: { order: OrderListItem }) {
  const buyer = order.customer?.email ?? order.email;
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <Link
          href={`/dashboard/orders/${order.id}`}
          className="font-medium text-foreground hover:text-brand"
        >
          #{order.id}
        </Link>
        <div className="text-xs text-muted">
          {new Date(order.createdAt).toLocaleDateString()}
        </div>
      </td>
      <td className="px-4 py-3 text-muted">{order.site?.name ?? "—"}</td>
      <td className="px-4 py-3">
        {buyer ? (
          <span className="text-foreground">{buyer}</span>
        ) : (
          /*
            An agent-placed x402 order carries no buyer identity. Naming the
            agent is the truth; "Guest" would imply a person was there.
          */
          <span className="text-muted">{order.agent.name}</span>
        )}
      </td>
      <td className="px-4 py-3 tabular-nums text-muted">
        {order.itemised ? (
          `${order.unitCount} × ${order.lineCount} line${order.lineCount === 1 ? "" : "s"}`
        ) : (
          /*
            Orders placed before §18.7 were never itemised. Showing the legacy
            `quantity` as one line would dress a gap up as a fact.
          */
          <span title="This order predates itemisation">Not itemised</span>
        )}
      </td>
      <td className="px-4 py-3">
        {/* The rail, named. x402 and card are peers, never "payment method". */}
        <span className="text-muted uppercase text-xs tracking-wide">{order.provider}</span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={PAYMENT_VARIANTS[order.financialStatus]}>
            {PAYMENT_LABELS[order.financialStatus]}
          </Badge>
          {/* Only the outcomes that need attention get a second badge. */}
          {order.status === "failed" ? <Badge variant="error">Payment failed</Badge> : null}
          {order.status === "cancel" ? <Badge variant="neutral">Cancelled</Badge> : null}
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={FULFILLMENT_VARIANTS[order.fulfillmentStatus]}>
          {FULFILLMENT_LABELS[order.fulfillmentStatus]}
        </Badge>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="tabular-nums font-medium text-foreground">
          {formatMinor(order.amountCents, order.currency)}
        </div>
        {order.refundedMinor > 0 ? (
          <div className="text-xs tabular-nums text-muted">
            −{formatMinor(order.refundedMinor, order.currency)} refunded
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;
  const status = firstParam(sp.status) as Order["status"] | undefined;
  const financialStatus = firstParam(sp.financialStatus) as Order["financialStatus"] | undefined;
  const fulfillmentStatus = firstParam(sp.fulfillmentStatus) as
    | Order["fulfillmentStatus"]
    | undefined;
  const provider = firstParam(sp.provider) as Order["provider"] | undefined;
  const from = firstParam(sp.from);
  const to = firstParam(sp.to);
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const filters = { q, siteId, status, financialStatus, fulfillmentStatus, provider, from, to };

  const [orders, sites] = await Promise.all([
    loadOrError(() => listOrders({ ...filters, page, limit })),
    loadOrError(() => listSites({ limit: 100 })),
  ]);

  const filtered = Boolean(
    q || siteId || status || financialStatus || fulfillmentStatus || provider || from || to,
  );

  return (
    <div>
      <PageHeader
        title="Orders"
        description="Every order across your stores, on whichever rail it was paid."
        actions={
          orders.data && orders.data.items.length > 0 ? (
            /*
              The export applies these same filters, so the file matches this
              screen. `download` keeps the router out of it — this response is an
              attachment, not a page.
            */
            <ButtonLink
              href={ordersExportUrl(filters)}
              download
              prefetch={false}
              variant="secondary"
            >
              Export CSV
            </ButtonLink>
          ) : undefined
        }
      />
      <OrdersSubnav />

      <ListFilters
        searchPlaceholder="Order number, email, tx hash…"
        dateRange
        filters={[
          ...(sites.data && sites.data.items.length > 1
            ? [
                {
                  key: "siteId",
                  label: "Store",
                  options: sites.data.items.map((s) => ({
                    value: String(s.id),
                    label: s.name,
                  })),
                },
              ]
            : []),
          { key: "status", label: "Status", options: STATUS_FILTER },
          {
            key: "financialStatus",
            label: "Payment",
            options: (Object.keys(PAYMENT_LABELS) as Order["financialStatus"][]).map((k) => ({
              value: k,
              label: PAYMENT_LABELS[k],
            })),
          },
          {
            key: "fulfillmentStatus",
            label: "Fulfillment",
            options: (Object.keys(FULFILLMENT_LABELS) as Order["fulfillmentStatus"][]).map(
              (k) => ({ value: k, label: FULFILLMENT_LABELS[k] }),
            ),
          },
          {
            key: "provider",
            label: "Rail",
            options: [
              { value: "x402", label: "x402" },
              { value: "stripe", label: "Stripe" },
            ],
          },
        ]}
      />

      {!orders.data ? (
        <FetchError message={orders.error ?? "Orders could not be loaded."} />
      ) : orders.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? "No orders matched" : "No orders yet"}
          description={
            filtered
              ? "Try a wider date range, or clear a filter."
              : "Orders appear here the moment a shopper or an agent completes a checkout on one of your stores."
          }
        />
      ) : (
        <>
          <Totals totals={orders.data.totals} />

          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
            <table className="w-full min-w-[60rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">Store</th>
                  <th className="px-4 py-3 font-medium">Buyer</th>
                  <th className="px-4 py-3 font-medium">Items</th>
                  <th className="px-4 py-3 font-medium">Rail</th>
                  <th className="px-4 py-3 font-medium">Payment</th>
                  <th className="px-4 py-3 font-medium">Fulfillment</th>
                  <th className="px-4 py-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.items.map((o) => (
                  <OrderRow key={o.id} order={o} />
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={orders.data.page}
            limit={orders.data.limit}
            total={orders.data.total}
          />
        </>
      )}
    </div>
  );
}
