import {
  button,
  esc,
  lineTable,
  money,
  paragraph,
  renderHtml,
  renderText,
  type RenderedEmail,
} from "./layout";

/**
 * Abandoned-cart recovery mail (§24, D27).
 *
 * **This is the one merchant email a shopper did not ask for**, and the copy is
 * shaped by that. Order confirmations, shipping notices and delivery links are
 * all responses to something the shopper did; this one arrives because they
 * *stopped*. So it says plainly why it was sent, it goes out **once**, and it
 * never manufactures urgency — no invented stock scarcity, no countdown, no
 * "your cart is about to expire" when it lives for a fortnight. A recovery email
 * that lies about timing is the same fabrication rule the rest of the codebase
 * refuses, pointed at a customer instead of a merchant.
 */

export type AbandonedCartItem = {
  name: string;
  quantity: number;
  unitPriceMinor: number;
};

export type AbandonedCartContext = {
  storeName: string;
  items: AbandonedCartItem[];
  subtotalMinor: number;
  currency: string;
  /** Restores the cart on the storefront. The token in it *is* the cart. */
  recoverUrl: string;
  supportEmail: string | null;
};

export function abandonedCart(ctx: AbandonedCartContext): RenderedEmail {
  const lines = ctx.items.map((i) => ({
    title: i.name,
    quantity: i.quantity,
    amount: money(i.unitPriceMinor * i.quantity, ctx.currency),
  }));

  const html = renderHtml({
    storeName: ctx.storeName,
    heading: "You left something behind",
    blocks: [
      paragraph(`Your cart at ${esc(ctx.storeName)} is still here, exactly as you left it.`),
      lineTable(lines),
      paragraph(`Subtotal: ${esc(money(ctx.subtotalMinor, ctx.currency))}`),
      button("Return to your cart", ctx.recoverUrl),
      /**
       * Shipping and tax are deliberately absent, not forgotten: neither is
       * known until an address is entered, and printing a total here that
       * checkout then contradicts is worse than printing no total.
       */
      paragraph("Shipping and tax are worked out at checkout."),
    ],
    footer: [
      // Says why it arrived. A shopper who cannot tell why they got a message
      // reasonably treats it as spam — and reports it as such.
      `You are receiving this because you left items in your cart at ${esc(ctx.storeName)}. This is the only reminder we will send.`,
      ...(ctx.supportEmail ? [`Questions? ${esc(ctx.supportEmail)}`] : []),
    ],
  });

  const text = renderText([
    "You left something behind",
    "",
    `Your cart at ${ctx.storeName} is still here, exactly as you left it.`,
    "",
    ...ctx.items.map(
      (i) => `- ${i.name}${i.quantity > 1 ? ` x ${i.quantity}` : ""}  ${money(i.unitPriceMinor * i.quantity, ctx.currency)}`,
    ),
    "",
    `Subtotal: ${money(ctx.subtotalMinor, ctx.currency)}`,
    "Shipping and tax are worked out at checkout.",
    "",
    ctx.recoverUrl,
    "",
    `You are receiving this because you left items in your cart at ${ctx.storeName}.`,
    "This is the only reminder we will send.",
    ...(ctx.supportEmail ? [`Questions? ${ctx.supportEmail}`] : []),
  ]);

  return { subject: `Your cart at ${ctx.storeName}`, html, text };
}
