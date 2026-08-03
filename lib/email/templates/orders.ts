import {
  button,
  esc,
  lineTable,
  money,
  paragraph,
  renderHtml,
  renderText,
  totalRow,
  totalsTable,
  type RenderedEmail,
} from "./layout";

/**
 * Transactional order mail (§6).
 *
 * Every template is a **pure function** of an order snapshot: no database, no
 * clock, no environment. That is what makes them testable, and the arithmetic
 * shown to a customer is exactly the arithmetic that was stored — these render
 * `subtotalMinor`/`taxMinor`/`shippingMinor` as they were frozen onto the order,
 * and never re-derive a total from the parts. A receipt that disagrees with the
 * charge is a support ticket at best.
 */

export type OrderMailLine = {
  title: string;
  variantTitle?: string | null;
  sku?: string | null;
  quantity: number;
  totalMinor: number;
};

export type OrderMailContext = {
  storeName: string;
  orderId: number;
  currency: string;
  lines: OrderMailLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  /** What was actually charged. Rendered, never recomputed. */
  totalMinor: number;
  /** Where the shopper can look the order up, when the store has such a page. */
  orderUrl?: string | null;
  supportEmail?: string | null;
};

function lineNote(line: OrderMailLine): string | null {
  const parts = [line.variantTitle, line.sku ? `SKU ${line.sku}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function htmlLines(ctx: OrderMailContext): string {
  return lineTable(
    ctx.lines.map((l) => ({
      title: l.title,
      note: lineNote(l),
      quantity: l.quantity,
      amount: money(l.totalMinor, ctx.currency),
    })),
  );
}

function textLines(ctx: OrderMailContext): string[] {
  return ctx.lines.map((l) => {
    const note = lineNote(l);
    return `  ${l.quantity} x ${l.title}${note ? ` (${note})` : ""} — ${money(l.totalMinor, ctx.currency)}`;
  });
}

/**
 * The money block.
 *
 * Discount, tax and shipping rows are **omitted when zero** rather than shown as
 * `$0.00`: a shopper scanning a receipt for "was I charged tax?" reads an
 * explicit zero as a claim, and on a rail with no tax configured that claim
 * would be one we cannot stand behind.
 */
function htmlTotals(ctx: OrderMailContext): string {
  const rows = [totalRow("Subtotal", money(ctx.subtotalMinor, ctx.currency))];
  if (ctx.discountMinor > 0) {
    rows.push(totalRow("Discount", `−${money(ctx.discountMinor, ctx.currency)}`));
  }
  if (ctx.shippingMinor > 0) rows.push(totalRow("Shipping", money(ctx.shippingMinor, ctx.currency)));
  if (ctx.taxMinor > 0) rows.push(totalRow("Tax", money(ctx.taxMinor, ctx.currency)));
  rows.push(totalRow("Total", money(ctx.totalMinor, ctx.currency), true));
  return totalsTable(rows);
}

function textTotals(ctx: OrderMailContext): string[] {
  const out = [`  Subtotal: ${money(ctx.subtotalMinor, ctx.currency)}`];
  if (ctx.discountMinor > 0) out.push(`  Discount: -${money(ctx.discountMinor, ctx.currency)}`);
  if (ctx.shippingMinor > 0) out.push(`  Shipping: ${money(ctx.shippingMinor, ctx.currency)}`);
  if (ctx.taxMinor > 0) out.push(`  Tax: ${money(ctx.taxMinor, ctx.currency)}`);
  out.push(`  Total: ${money(ctx.totalMinor, ctx.currency)}`);
  return out;
}

function footer(ctx: OrderMailContext): string[] {
  return ctx.supportEmail
    ? [`Questions about this order? Reply to this email or contact ${esc(ctx.supportEmail)}.`]
    : ["Questions about this order? Just reply to this email."];
}

export function orderConfirmation(ctx: OrderMailContext): RenderedEmail {
  return {
    subject: `Order #${ctx.orderId} confirmed — ${ctx.storeName}`,
    html: renderHtml({
      storeName: ctx.storeName,
      heading: `Thanks for your order`,
      blocks: [
        paragraph(`Order #${ctx.orderId} is confirmed. Here is what you bought.`),
        htmlLines(ctx),
        htmlTotals(ctx),
        ...(ctx.orderUrl ? [button("View your order", ctx.orderUrl)] : []),
      ],
      footer: footer(ctx),
    }),
    text: renderText([
      `Thanks for your order`,
      ``,
      `Order #${ctx.orderId} is confirmed.`,
      ``,
      ...textLines(ctx),
      ``,
      ...textTotals(ctx),
      ctx.orderUrl ? `` : null,
      ctx.orderUrl ? `View your order: ${ctx.orderUrl}` : null,
      ``,
      `— ${ctx.storeName}`,
    ]),
  };
}

export type ShippingNoticeInput = {
  order: OrderMailContext;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  /** Which lines shipped. A partial shipment must not imply the whole order did. */
  shipped: { title: string; quantity: number }[];
  /** True when some of the order is still to come. */
  partial: boolean;
};

export function shippingNotice(input: ShippingNoticeInput): RenderedEmail {
  const { order } = input;
  const what = input.partial ? "Part of your order is on its way" : "Your order is on its way";

  const trackingBits = [
    input.carrier ? `Carrier: ${input.carrier}` : null,
    input.trackingNumber ? `Tracking: ${input.trackingNumber}` : null,
  ].filter(Boolean) as string[];

  return {
    subject: `Order #${order.orderId} has shipped — ${order.storeName}`,
    html: renderHtml({
      storeName: order.storeName,
      heading: what,
      blocks: [
        paragraph(
          input.partial
            ? `Some of order #${order.orderId} has shipped. The rest will follow separately.`
            : `Order #${order.orderId} has shipped.`,
        ),
        lineTable(
          input.shipped.map((l) => ({ title: l.title, quantity: l.quantity, amount: "" })),
        ),
        ...(trackingBits.length > 0 ? [paragraph(trackingBits.join(" · "))] : []),
        ...(input.trackingUrl ? [button("Track your shipment", input.trackingUrl)] : []),
      ],
      footer: footer(order),
    }),
    text: renderText([
      what,
      ``,
      input.partial
        ? `Some of order #${order.orderId} has shipped. The rest will follow separately.`
        : `Order #${order.orderId} has shipped.`,
      ``,
      ...input.shipped.map((l) => `  ${l.quantity} x ${l.title}`),
      trackingBits.length > 0 ? `` : null,
      ...trackingBits.map((b) => `  ${b}`),
      input.trackingUrl ? `` : null,
      input.trackingUrl ? `Track your shipment: ${input.trackingUrl}` : null,
      ``,
      `— ${order.storeName}`,
    ]),
  };
}

export type RefundNoticeInput = {
  order: OrderMailContext;
  refundedMinor: number;
  /** What was returned. Empty for an order-level refund with no line detail. */
  lines: { title: string; quantity: number }[];
  /**
   * True only when a payment processor confirmed the reversal.
   *
   * **Load-bearing wording, not a flag for styling.** Markii never holds
   * merchant funds and the card rail is not wired, so today's refunds are
   * `manual` — the merchant asserting they sent the money back themselves, by
   * whatever means. On x402/USDC there is no reversal at all, only a new
   * transfer. Promising a shopper "it will appear on your original payment
   * method" in that case is a claim about a mechanism that was never invoked,
   * and it is the shopper who waits for something that is not coming.
   */
  settled: boolean;
  /** `manual`, `stripe`, `x402`, `external` — named explicitly, rails are peers. */
  rail: string;
};

export function refundNotice(input: RefundNoticeInput): RenderedEmail {
  const { order } = input;
  const amount = money(input.refundedMinor, order.currency);

  const statusLine = input.settled
    ? `A refund of ${amount} has been sent back to your original payment method. Depending on your bank it can take a few days to appear.`
    : `${order.storeName} has issued a refund of ${amount} for this order. It was sent by the ` +
      `store directly rather than reversed through your original payment, so how it reaches you ` +
      `depends on the method they used.`;

  return {
    subject: `Refund of ${amount} for order #${order.orderId} — ${order.storeName}`,
    html: renderHtml({
      storeName: order.storeName,
      heading: `Your refund`,
      blocks: [
        paragraph(statusLine),
        ...(input.lines.length > 0
          ? [
              lineTable(
                input.lines.map((l) => ({ title: l.title, quantity: l.quantity, amount: "" })),
              ),
            ]
          : []),
        totalsTable([totalRow("Refunded", amount, true)]),
      ],
      footer: footer(order),
    }),
    text: renderText([
      `Your refund`,
      ``,
      statusLine,
      input.lines.length > 0 ? `` : null,
      ...input.lines.map((l) => `  ${l.quantity} x ${l.title}`),
      ``,
      `  Refunded: ${amount}`,
      ``,
      `— ${order.storeName}`,
    ]),
  };
}

export type CancellationNoticeInput = {
  order: OrderMailContext;
  reason: string;
  /** Whether a refund accompanies the cancellation. */
  refundedMinor: number;
};

export function cancellationNotice(input: CancellationNoticeInput): RenderedEmail {
  const { order } = input;
  const refunded =
    input.refundedMinor > 0
      ? `A refund of ${money(input.refundedMinor, order.currency)} has been recorded for this order.`
      : `You have not been charged for this order.`;

  return {
    subject: `Order #${order.orderId} was cancelled — ${order.storeName}`,
    html: renderHtml({
      storeName: order.storeName,
      heading: `Your order was cancelled`,
      blocks: [
        paragraph(`Order #${order.orderId} has been cancelled.`),
        paragraph(`Reason: ${input.reason}`),
        paragraph(refunded),
      ],
      footer: footer(order),
    }),
    text: renderText([
      `Your order was cancelled`,
      ``,
      `Order #${order.orderId} has been cancelled.`,
      `Reason: ${input.reason}`,
      ``,
      refunded,
      ``,
      `— ${order.storeName}`,
    ]),
  };
}
