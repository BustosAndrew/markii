import "server-only";

import { eq } from "drizzle-orm";
import { db, orderLines, sites, type DbHandle, type Order, type OrderLine } from "../db";
import type { OrderMailContext } from "./templates";

/**
 * Turning stored rows into the shape a template renders.
 *
 * Kept out of the templates themselves so those stay pure — no database, no
 * clock — and can be tested by constructing an object rather than a store.
 */

/**
 * The store's name and reply address, for the From header and the footer.
 *
 * Falls back to the organization's name only if the site is gone, which happens
 * when a site is deleted out from under a historic order (`orders.siteId` is
 * `set null`). A receipt without a store name is still worth sending.
 */
export async function storeIdentity(
  siteId: number | null,
  handle: DbHandle = db,
): Promise<{ storeName: string; supportEmail: string | null }> {
  if (siteId == null) return { storeName: "Your order", supportEmail: null };
  const [site] = await handle
    .select({ name: sites.name })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  return { storeName: site?.name ?? "Your order", supportEmail: null };
}

/**
 * Build the money and line context for an order email.
 *
 * `totalMinor` comes from `amountCents` — the v1 total field, which stays named
 * as it is (`CLAUDE.md`) — rather than being recomputed from subtotal, tax and
 * shipping. Those parts were frozen at checkout and the total is what was
 * actually charged; if they ever disagree, the customer's receipt must show the
 * charge, not our arithmetic.
 */
export function orderMailContext(input: {
  order: Order;
  lines: OrderLine[];
  storeName: string;
  supportEmail?: string | null;
  orderUrl?: string | null;
}): OrderMailContext {
  const { order } = input;
  return {
    storeName: input.storeName,
    orderId: order.id,
    currency: order.currency,
    lines: input.lines.map((l) => ({
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      totalMinor: l.totalMinor,
    })),
    subtotalMinor: order.subtotalMinor,
    discountMinor: order.discountMinor,
    taxMinor: order.taxMinor,
    shippingMinor: order.shippingMinor,
    totalMinor: order.amountCents,
    orderUrl: input.orderUrl ?? null,
    supportEmail: input.supportEmail ?? null,
  };
}

/** Lines for an order, ordered stably so a receipt reads the same way twice. */
export function orderLinesFor(orderId: number, handle: DbHandle = db): Promise<OrderLine[]> {
  return handle.select().from(orderLines).where(eq(orderLines.orderId, orderId));
}
