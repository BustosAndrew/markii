import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  cartLines,
  carts,
  checkoutSessions,
  db,
  orders,
  organizations,
  products,
  sites,
  usageRecords,
  type CheckoutSession,
} from "../db";
import { recordRedemptions } from "./discounts";
import { consumeForSession, releaseForSession } from "./reservations";

/**
 * The single order pipeline (§18.4).
 *
 * `docs/BACKEND.md` §4: the usage record is written on order completion "both
 * for card checkout *and* the existing x402 path, which must flow into the same
 * order pipeline." That is the whole reason this module exists rather than each
 * rail creating its own order. Payment rails are peers (`CLAUDE.md`); what they
 * are peers *at* is this function.
 *
 * Everything below the payment happens in one transaction — order row, stock
 * consumption, usage record, cart conversion. A sale that records an order but
 * not its metering event is a sale the threshold meter never sees, and §17 says
 * usage is "written at event time, never derived later", so there is no later
 * pass that could repair it.
 */

export type CompletionInput = {
  session: CheckoutSession;
  /** Stripe PaymentIntent id or the on-chain transaction hash. */
  paymentReference: string;
  /** Wallet or card holder, when the rail exposes one. */
  payerReference?: string | null;
  userAgent?: string | null;
  agentName?: string | null;
};

/**
 * Whether a sale counts toward billing.
 *
 * Test never counts (§17), and the no-fabrication rule makes this stricter than
 * it looks: a store that is not `live` is not making production sales, and a
 * payment accepted with verification disabled is not a payment. Either one makes
 * the record `test`, so demo traffic and the seed can never inflate a real
 * merchant's threshold meter.
 */
export function environmentFor(opts: {
  siteStatus: string;
  paymentVerified: boolean;
}): "test" | "production" {
  if (opts.siteStatus !== "live") return "test";
  if (!opts.paymentVerified) return "test";
  return "production";
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Writes the metering event for an order (§17).
 *
 * Converts to the org's billing currency only when no conversion is needed. No
 * FX provider is wired, so a differing currency stores `null` — a visible gap
 * the meter must report rather than an invented rate summed into a number that
 * decides what a merchant is charged.
 */
export async function recordUsage(
  tx: Tx,
  input: {
    orgId: string;
    siteId: number | null;
    orderId: number;
    type: "sale" | "refund" | "chargeback_lost";
    amountMinor: number;
    currency: string;
    environment: "test" | "production";
    occurredAt?: Date;
  },
): Promise<void> {
  const [org] = await tx
    .select({ currency: organizations.currency })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);

  const sameCurrency = org?.currency === input.currency;

  await tx
    .insert(usageRecords)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      siteId: input.siteId,
      orderId: input.orderId,
      type: input.type,
      amountMinor: input.amountMinor,
      currency: input.currency,
      convertedMinor: sameCurrency ? input.amountMinor : null,
      fxRate: sameCurrency ? "1" : null,
      environment: input.environment,
      occurredAt: input.occurredAt ?? new Date(),
    })
    // The completion path is retried by Stripe webhooks and by agents.
    // Double-counting a sale overcharges a merchant at the threshold.
    .onConflictDoNothing({ target: [usageRecords.orderId, usageRecords.type] });
}

export type CompletionResult = {
  orderId: number;
  alreadyCompleted: boolean;
};

/**
 * Completes a paid checkout: order, stock, metering, cart — atomically.
 *
 * Safe to call twice. A session already `completed` returns its existing order
 * rather than creating a second one, which matters because both a webhook and a
 * client redirect will race to call this.
 */
export async function completeCheckout(input: CompletionInput): Promise<CompletionResult> {
  const { session } = input;

  return db.transaction(async (tx) => {
    /**
     * Re-read under a row lock. Without it, two concurrent completions both see
     * `requires_payment` and both create an order — the shopper is charged once
     * and the merchant ships twice.
     */
    const [current] = await tx
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, session.id))
      .limit(1)
      .for("update");
    if (!current) throw new Error(`Checkout session ${session.id} disappeared`);

    if (current.status === "completed" && current.orderId != null) {
      return { orderId: current.orderId, alreadyCompleted: true };
    }

    const [site] = await tx
      .select({ id: sites.id, orgId: sites.orgId, status: sites.status })
      .from(sites)
      .where(eq(sites.id, current.siteId))
      .limit(1);
    if (!site) throw new Error(`Store ${current.siteId} disappeared mid-checkout`);

    const lines = await tx.select().from(cartLines).where(eq(cartLines.cartId, current.cartId));

    /**
     * `orders` is still one row per product from v1 (§1–8) and the multi-line
     * order table is §18.7 work. Until then the order references the first
     * line's product and carries the session's authoritative total, so the
     * money is right even while the line detail lives on the cart. The
     * checkout session id is what ties an order back to its full contents.
     */
    const [order] = await tx
      .insert(orders)
      .values({
        siteId: current.siteId,
        productId: lines[0]?.productId ?? null,
        customerId: current.customerId,
        quantity: lines.reduce((s, l) => s + l.quantity, 0) || 1,
        status: "success" as const,
        amountCents: current.totalMinor,
        currency: current.currency,
        provider: current.provider,
        txHash: current.provider === "x402" ? input.paymentReference : null,
        agentUserAgent: input.userAgent ?? "",
        agentName: input.agentName ?? "Other",
        agentWalletAddress: input.payerReference ?? null,
      })
      .returning();

    // Variant-backed stock leaves here; variant-less products still decrement
    // their own counter until the catalog finishes migrating to variants.
    await consumeForSession(tx, current.id);
    for (const line of lines) {
      if (line.variantId != null) continue;
      await tx
        .update(products)
        .set({
          stock: sql`greatest(${products.stock} - ${line.quantity}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(products.id, line.productId));
    }

    /**
     * **Net sales, not the order total** (`docs/PRICING.md` §4.1):
     *
     *     net_sales = line item totals − discounts − refunds − chargebacks lost
     *     excludes: taxes, shipping charges, gift-card purchases, tips
     *
     * The order is charged `totalMinor`; the *meter* sees subtotal minus
     * discounts. Metering the total would bill a merchant against tax they
     * merely collected on a government's behalf and postage they passed
     * through — inflating their threshold with money that was never revenue,
     * and doing it worst to whoever ships the most.
     */
    const netSalesMinor = current.subtotalMinor - current.discountMinor;

    /**
     * Burn the discounts this quote was built on (§18.5). Recorded here rather
     * than at session creation because a checkout that is never paid must not
     * consume someone's single-use code.
     *
     * **Known limit, stated rather than papered over:** two checkouts of a
     * last-remaining use can both complete, exceeding `usageLimit` by one. The
     * unique key stops one order counting twice, not two orders racing. Refusing
     * at completion is worse — on the x402 rail the shopper has already settled
     * on-chain, so it would take their money and give nothing. Closing it
     * properly needs a reservation like inventory's, which is the right fix if
     * this ever matters more than the money it would strand.
     */
    await recordRedemptions(tx, {
      orderId: order.id,
      customerId: current.customerId,
      applied: current.appliedDiscounts,
    });

    await recordUsage(tx, {
      orgId: site.orgId,
      siteId: site.id,
      orderId: order.id,
      type: "sale",
      amountMinor: netSalesMinor,
      currency: current.currency,
      environment: environmentFor({ siteStatus: site.status, paymentVerified: true }),
    });

    await tx
      .update(checkoutSessions)
      .set({
        status: "completed",
        orderId: order.id,
        paymentReference: input.paymentReference,
        completedAt: new Date(),
      })
      .where(eq(checkoutSessions.id, current.id));

    await tx
      .update(carts)
      .set({ status: "converted", updatedAt: new Date() })
      .where(eq(carts.id, current.cartId));

    return { orderId: order.id, alreadyCompleted: false };
  });
}

/** Marks a checkout failed and gives its held stock back. */
export async function failCheckout(sessionId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await releaseForSession(tx, sessionId, reason);
    await tx
      .update(checkoutSessions)
      .set({ status: "failed", failureReason: reason })
      .where(
        and(
          eq(checkoutSessions.id, sessionId),
          // A completed checkout is never walked back by a late failure signal.
          sql`${checkoutSessions.status} in ('requires_payment', 'processing')`,
        ),
      );
  });
}
