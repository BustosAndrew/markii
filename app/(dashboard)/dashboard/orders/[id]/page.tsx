import Link from "next/link";
import { notFound } from "next/navigation";
import { FetchError } from "@/components/dashboard/fetch-error";
import { OrderActions } from "@/components/dashboard/order-actions";
import { OrderDownloads } from "@/components/dashboard/order-downloads";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/components/ui/timeline";
import { loadOrError } from "@/lib/api/load";
import { formatMinor } from "@/lib/api/money";
import type {
  OrderDetail,
  OrderEvent,
  OrderFulfillment,
  OrderLicenceKey,
  OrderRefund,
} from "@/lib/api/orders";
import { getOrder } from "@/lib/api/server";

/**
 * `/dashboard/orders/:id` (§13, extended by §18.7 and §18.8).
 *
 * Everything arrives in one response, and it is displayed the way it arrived:
 * the totals, the refunds that reduced them, and the timeline that explains
 * both. Fetching them separately would let this page show a total that
 * disagrees with the refunds beside it.
 *
 * **Actions** invoke registry mutations through `lib/api/actions` (§22).
 *
 * Money uses **the order's own currency** throughout (D31) — never the org's,
 * and never a hardcoded `/100`.
 */

const PAYMENT_LABELS: Record<OrderDetail["financialStatus"], string> = {
  pending: "Unpaid",
  paid: "Paid",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  voided: "Voided",
};

const FULFILLMENT_LABELS: Record<OrderDetail["fulfillmentStatus"], string> = {
  unfulfilled: "Unfulfilled",
  partially_fulfilled: "Partly shipped",
  fulfilled: "Fulfilled",
  not_required: "No shipping",
};

const REFUND_REASONS: Record<OrderRefund["reason"], string> = {
  requested_by_customer: "Requested by customer",
  duplicate: "Duplicate",
  fraudulent: "Fraudulent",
  item_unavailable: "Item unavailable",
  other: "Other",
};

const EVENT_TONES: Record<OrderEvent["type"], "success" | "warning" | "error" | "info" | "default"> =
  {
    placed: "success",
    note: "default",
    refunded: "warning",
    cancelled: "warning",
    fulfilled: "success",
    fulfillment_updated: "info",
    email_sent: "info",
    /** A send that did not happen is shown as a failure, never quietly dropped. */
    email_failed: "error",
  };

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-sm)]">
      {children}
    </div>
  );
}

function Lines({ order }: { order: OrderDetail }) {
  const { currency } = order.totals;
  if (!order.itemised) {
    return (
      <Card>
        <p className="text-sm text-muted">
          This order was never itemised. Rebuilding lines from today&rsquo;s catalog would show
          prices nobody paid. The totals below are the amounts actually charged.
        </p>
      </Card>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
      <table className="w-full min-w-[42rem] text-left text-sm">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="px-4 py-3 font-medium">Item</th>
            <th className="px-4 py-3 font-medium">Qty</th>
            <th className="px-4 py-3 font-medium">Refundable</th>
            <th className="px-4 py-3 font-medium">To ship</th>
            <th className="px-4 py-3 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3">
                <div className="font-medium text-foreground">{line.title}</div>
                {line.variantTitle ? (
                  <div className="text-xs text-muted">{line.variantTitle}</div>
                ) : null}
                {line.sku ? <div className="text-xs text-muted">SKU {line.sku}</div> : null}
                {line.addOns.length > 0 ? (
                  <ul className="mt-1 text-xs text-muted">
                    {line.addOns.map((a) => (
                      <li key={a.productId}>
                        + {a.name} ({formatMinor(a.unitPriceMinor, currency)})
                      </li>
                    ))}
                  </ul>
                ) : null}
              </td>
              <td className="px-4 py-3 tabular-nums text-foreground">{line.quantity}</td>
              <td className="px-4 py-3 tabular-nums text-muted">
                {line.quantityRefundable}
                {line.quantityRefunded > 0 ? (
                  <span className="ml-1 text-xs">({line.quantityRefunded} refunded)</span>
                ) : null}
              </td>
              <td className="px-4 py-3 tabular-nums text-muted">{line.quantityUnfulfilled}</td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {formatMinor(line.totalMinor, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Totals({ order }: { order: OrderDetail }) {
  const t = order.totals;
  const rows: [string, number][] = [
    ["Subtotal", t.subtotalMinor],
    ["Discount", -t.discountMinor],
    ["Tax", t.taxMinor],
    ["Shipping", t.shippingMinor],
  ];
  return (
    <Card>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-muted">{label}</dt>
            <dd className="tabular-nums text-foreground">{formatMinor(value, t.currency)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 border-t border-border pt-2 font-medium">
          <dt className="text-foreground">Total</dt>
          <dd className="tabular-nums text-foreground">{formatMinor(t.totalMinor, t.currency)}</dd>
        </div>
        {t.refundedMinor > 0 ? (
          <>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Refunded</dt>
              <dd className="tabular-nums text-foreground">
                −{formatMinor(t.refundedMinor, t.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Still refundable</dt>
              <dd className="tabular-nums text-foreground">
                {formatMinor(t.refundableMinor, t.currency)}
              </dd>
            </div>
          </>
        ) : null}
      </dl>
    </Card>
  );
}

function Refunds({ refunds, currency }: { refunds: OrderRefund[]; currency: string }) {
  return (
    <div className="space-y-3">
      {refunds.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium tabular-nums text-foreground">
              {formatMinor(r.amountMinor, r.currency || currency)}
            </span>
            <span className="text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="neutral">{REFUND_REASONS[r.reason]}</Badge>
            <Badge variant="neutral">Rail: {r.rail}</Badge>
            {r.restock ? <Badge variant="info">Restocked</Badge> : null}
          </div>
          {r.note ? <p className="mt-2 text-sm text-muted">{r.note}</p> : null}
          {/*
            Stated on every refund, because the two are indistinguishable in a
            list and are not the same event. Markii can now issue a card refund
            on the merchant's own Stripe account (§18.7) — but x402 settlement
            still cannot be reversed, so a `manual` refund means the merchant
            sent the money back themselves. Implying otherwise would be a
            success toast for a transfer nobody made.
          */}
          <p className="mt-2 text-xs text-muted">
            {r.moneyMovedByMarkii
              ? "Markii moved this money."
              : r.method === "manual"
                ? "Recorded by Markii — the money was returned by you, not by Markii."
                : "Recorded by Markii — Markii did not move this money."}
            {r.processorReference ? ` Reference: ${r.processorReference}` : ""}
          </p>
        </Card>
      ))}
    </div>
  );
}

function Fulfillments({ fulfillments }: { fulfillments: OrderFulfillment[] }) {
  return (
    <div className="space-y-3">
      {fulfillments.map((f) => (
        <Card key={f.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Badge variant={f.status === "delivered" ? "success" : "info"}>{f.status}</Badge>
            <span className="text-xs text-muted">{new Date(f.createdAt).toLocaleString()}</span>
          </div>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted">Carrier</dt>
              <dd className="text-foreground">{f.carrier ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Tracking</dt>
              <dd className="text-foreground">
                {f.trackingUrl && f.trackingNumber ? (
                  <a
                    href={f.trackingUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                    className="text-brand hover:underline"
                  >
                    {f.trackingNumber}
                  </a>
                ) : (
                  (f.trackingNumber ?? "—")
                )}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Customer notified</dt>
              {/* False is a real state, not a failure — say which it is. */}
              <dd className="text-foreground">{f.notifiedCustomer ? "Yes" : "No"}</dd>
            </div>
          </dl>
          {f.note ? <p className="mt-2 text-sm text-muted">{f.note}</p> : null}
          {!f.trackingVerified ? (
            <p className="mt-2 text-xs text-muted">
              Entered by you. Markii does no carrier integration, so this tracking number is not
              verified with {f.carrier ?? "the carrier"}.
            </p>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function LicenceKeys({ keys }: { keys: OrderLicenceKey[] }) {
  return (
    <Card>
      <ul className="space-y-2 text-sm">
        {keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-2">
            <code className="font-mono text-foreground">{k.key}</code>
            {k.revokedAt ? (
              <Badge variant="error">Returned to pool</Badge>
            ) : (
              <Badge variant="success">Assigned</Badge>
            )}
          </li>
        ))}
      </ul>
      {/* Markii never generates a key — the pool is the merchant's (§18.8). */}
      <p className="mt-3 text-xs text-muted">
        Keys come from the pool you uploaded. Markii never generates one.
      </p>
    </Card>
  );
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) notFound();

  const order = await loadOrError(() => getOrder(orderId));

  if (!order.data) {
    return (
      <div>
        <PageHeader
          title={`Order #${orderId}`}
          description=""
          actions={
            <Link href="/dashboard/orders" className="text-sm text-muted hover:text-foreground">
              Back to orders
            </Link>
          }
        />
        <FetchError message={order.error ?? "This order could not be loaded."} />
      </div>
    );
  }

  const o = order.data;
  const buyer = o.customer?.email ?? o.email;

  return (
    <div>
      <PageHeader
        title={`Order #${o.id}`}
        description={`${new Date(o.createdAt).toLocaleString()}${o.site ? ` · ${o.site.name}` : ""}`}
        actions={
          <Link href="/dashboard/orders" className="text-sm text-muted hover:text-foreground">
            Back to orders
          </Link>
        }
      />

      <div className="mb-8 flex flex-wrap items-center gap-2">
        <Badge variant={o.financialStatus === "paid" ? "success" : "warning"}>
          {PAYMENT_LABELS[o.financialStatus]}
        </Badge>
        <Badge variant={o.fulfillmentStatus === "fulfilled" ? "success" : "neutral"}>
          {FULFILLMENT_LABELS[o.fulfillmentStatus]}
        </Badge>
        {o.status === "failed" ? <Badge variant="error">Payment failed</Badge> : null}
        {o.cancelledAt ? <Badge variant="neutral">Cancelled</Badge> : null}
        {/* The rail, named explicitly wherever a payment appears. */}
        <Badge variant="info">Rail: {o.provider}</Badge>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          <Section title="Items">
            <Lines order={o} />
          </Section>

          {o.refunds.length > 0 ? (
            <Section
              title="Refunds"
              description="Markii records refunds; it does not hold or move merchant funds."
            >
              <Refunds refunds={o.refunds} currency={o.totals.currency} />
            </Section>
          ) : null}

          {o.fulfillments.length > 0 ? (
            <Section title="Shipments">
              <Fulfillments fulfillments={o.fulfillments} />
            </Section>
          ) : null}

          {o.downloads.length > 0 ? (
            <Section title="Digital delivery">
              <OrderDownloads downloads={o.downloads} />
            </Section>
          ) : null}

          {o.licenceKeys.length > 0 ? (
            <Section title="Licence keys">
              <LicenceKeys keys={o.licenceKeys} />
            </Section>
          ) : null}

          <Section title="Timeline">
            {o.timeline.length === 0 ? (
              <EmptyState
                title="Nothing recorded yet"
                description="Events appear here as the order is paid, shipped, refunded, or noted."
              />
            ) : (
              <Timeline
                events={o.timeline.map((e) => ({
                  id: String(e.id),
                  title: e.message,
                  description: [
                    e.actorLabel ?? e.actorType,
                    /*
                      Whether the shopper saw it. An internal note leaking into a
                      customer-facing view is a support incident, so the
                      distinction is shown rather than assumed.
                    */
                    e.visibility === "customer" ? "shown to customer" : "internal",
                  ].join(" · "),
                  timestamp: new Date(e.createdAt).toLocaleString(),
                  tone: EVENT_TONES[e.type],
                }))}
              />
            )}
          </Section>
        </div>

        <aside className="space-y-6">
          <Section title="Totals">
            <Totals order={o} />
          </Section>

          <Section title="Buyer">
            <Card>
              {buyer ? (
                <div className="text-sm">
                  {o.customer ? (
                    <Link
                      href={`/dashboard/customers/${o.customer.id}`}
                      className="font-medium text-foreground hover:text-brand"
                    >
                      {buyer}
                    </Link>
                  ) : (
                    <span className="text-foreground">{buyer}</span>
                  )}
                  {o.customer?.name ? (
                    <div className="text-xs text-muted">{o.customer.name}</div>
                  ) : null}
                  {!o.customer ? (
                    <div className="mt-1 text-xs text-muted">
                      Guest checkout — no customer account.
                    </div>
                  ) : null}
                </div>
              ) : (
                /*
                  An agent-placed order carries no buyer identity. Naming the
                  agent is the truth; "Guest" would imply a person was there.
                */
                <div className="text-sm text-muted">
                  No buyer identity — this order was placed by an agent.
                </div>
              )}
            </Card>
          </Section>

          <Section title="Agent">
            <Card>
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Name</dt>
                  <dd className="text-foreground">{o.agent.name}</dd>
                </div>
                {o.agent.walletAddress ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Wallet</dt>
                    <dd className="truncate font-mono text-xs text-foreground">
                      {o.agent.walletAddress}
                    </dd>
                  </div>
                ) : null}
                {o.txHash ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Transaction</dt>
                    <dd className="truncate font-mono text-xs text-foreground">{o.txHash}</dd>
                  </div>
                ) : null}
              </dl>
            </Card>
          </Section>

          <Section title="Actions">
            <Card>
              <OrderActions order={o} />
            </Card>
          </Section>
        </aside>
      </div>
    </div>
  );
}
