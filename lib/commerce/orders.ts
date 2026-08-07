import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  cartLines,
  carts,
  checkoutSessions,
  db,
  inventoryReservations,
  orderEvents,
  orderLines,
  orders,
  organizations,
  products,
  sites,
  usageRecords,
  type CheckoutSession,
  type DbHandle,
} from "../db";
import { allocate } from "./allocation";
import { deliverableItems, issueDelivery } from "./delivery";
import { recordRedemptions } from "./discounts";
import { grantMembershipsForOrder } from "./memberships";
import { classifyProducts, splitNetSales, type ProductClass } from "./product-class";
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
  tx: DbHandle,
  input: {
    orgId: string;
    siteId: number | null;
    orderId: number;
    type: "sale" | "refund" | "chargeback_lost";
    amountMinor: number;
    currency: string;
    /**
     * Which fee schedule this money bills under (`docs/PRICING.md` §3).
     * Physical and digital have different rates and separate thresholds, so a
     * mixed basket writes one record per class.
     */
    productClass: ProductClass;
    environment: "test" | "production";
    /**
     * What caused this event — `sale:{orderId}`, `refund:{refundId}`. Retrying
     * the same cause is a no-op; a second, genuinely different refund on the
     * same order is a second record, which is the distinction the old
     * `(orderId, type)` key could not make.
     */
    dedupeKey: string;
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
      productClass: input.productClass,
      convertedMinor: sameCurrency ? input.amountMinor : null,
      fxRate: sameCurrency ? "1" : null,
      environment: input.environment,
      dedupeKey: input.dedupeKey,
      occurredAt: input.occurredAt ?? new Date(),
    })
    // The completion path is retried by Stripe webhooks and by agents.
    // Double-counting a sale overcharges a merchant at the threshold.
    .onConflictDoNothing({ target: usageRecords.dedupeKey });
}

/**
 * Writes the order's itemisation from the session's frozen line snapshot (§18.7).
 *
 * The snapshot is the source rather than the cart or the live catalog, because
 * these lines must sum to the amount that was charged. `priceCart` at this
 * moment could return different numbers — a price edited during the fifteen
 * minutes stock was held — and an order that charges one total while itemising
 * another is a refund waiting to return the wrong money.
 *
 * Discount and tax are **allocated**, not calculated: neither has a per-line
 * value of its own. `lib/commerce/allocation.ts` splits them so the parts sum
 * back exactly to the order's own totals.
 */
async function writeOrderLines(tx: Tx, orderId: number, session: CheckoutSession): Promise<void> {
  const snapshot = session.lineSnapshot;
  if (snapshot.length === 0) return;

  const weights = snapshot.map((l) => l.subtotalMinor);
  const discounts = allocate(session.discountMinor, weights);
  const taxes = allocate(session.taxMinor, weights);

  /**
   * Where each variant's stock actually left from, so a restock returns it to
   * the same place rather than to whichever location happens to be default
   * today. Variant-less products have no ledger and no location — their stock
   * is the legacy `products.stock` counter, and a restock adjusts that instead.
   */
  const held = await tx
    .select({
      variantId: inventoryReservations.variantId,
      locationId: inventoryReservations.locationId,
    })
    .from(inventoryReservations)
    .where(eq(inventoryReservations.checkoutSessionId, session.id));
  const locationByVariant = new Map(held.map((h) => [h.variantId, h.locationId]));

  await tx.insert(orderLines).values(
    snapshot.map((line, i) => ({
      orderId,
      productId: line.productId,
      variantId: line.variantId,
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      subtotalMinor: line.subtotalMinor,
      discountMinor: discounts[i],
      taxMinor: taxes[i],
      totalMinor: line.subtotalMinor - discounts[i] + taxes[i],
      addOns: line.addOns,
      locationId: line.variantId != null ? (locationByVariant.get(line.variantId) ?? null) : null,
    })),
  );
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
     * `orders` keeps its v1 shape — `productId`, `quantity`, `amountCents` — so
     * every §1–8 route and serializer that reads it goes on working. What §18.7
     * added beside it is the itemisation (`order_lines`) and the money split,
     * because a total alone cannot answer "refund two of the three mugs", and
     * net sales cannot be recomputed from it after the fact (D36).
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
        /**
         * Written for **both** rails, unlike `txHash`. A card refund has to name
         * the PaymentIntent it reverses, and `orders.refund` starts from the
         * order — leaving the reference only on the checkout session would make
         * the merchant's financial record unable to say what was charged.
         */
        paymentReference: input.paymentReference,
        agentUserAgent: input.userAgent ?? "",
        agentName: input.agentName ?? "Other",
        agentWalletAddress: input.payerReference ?? null,
        subtotalMinor: current.subtotalMinor,
        discountMinor: current.discountMinor,
        taxMinor: current.taxMinor,
        shippingMinor: current.shippingMinor,
        email: current.email,
        financialStatus: "paid" as const,
        /**
         * Digital goods and delivery are §18.7's last item and do not exist
         * yet, so every order starts shippable. Claiming `not_required` here
         * would tell a merchant a physical order needs no action.
         */
        fulfillmentStatus: "unfulfilled" as const,
      })
      .returning();

    await writeOrderLines(tx, order.id, current);

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
     *
     * **Gift cards are deferred (D33), and this line is why it matters.** The
     * exclusion above is asserted, not implemented — there is no gift-card term
     * here, and both obvious implementations are wrong in opposite directions:
     * sold as a product line the price lands in `subtotalMinor` and is metered
     * at purchase *and* again at redemption (the merchant is billed twice on one
     * pound); redeemed as a discount it reduces `discountMinor` and is metered
     * at neither. A gift card is a **tender**, not a line and not a discount, so
     * it needs its own term here rather than reusing either.
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

    /**
     * Metered **per fee class**, because physical and digital bill at different
     * rates against separate thresholds (`docs/PRICING.md` §3).
     *
     * The split comes from `order_lines`, whose `discountMinor` is already
     * allocated to sum back exactly to the order's own discount — so the two
     * classes sum to `netSalesMinor` and no money falls between the thresholds.
     * A class with nothing in it writes no record rather than a zero, which
     * keeps "sold no digital" distinguishable from "sold digital worth nothing".
     */
    const meteredLines = await tx
      .select({
        productId: orderLines.productId,
        subtotalMinor: orderLines.subtotalMinor,
        discountMinor: orderLines.discountMinor,
      })
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id));

    const classOf = await classifyProducts(tx, meteredLines.map((l) => l.productId));
    const split = splitNetSales(meteredLines, classOf);

    /**
     * Un-itemised orders — the direct x402 one-shot writes no lines — have
     * nothing to split, so they meter whole as `physical`. That is the cheaper
     * rate on every plan, and inventing a class for money whose composition is
     * unknown would move it onto a threshold on a guess.
     */
    if (meteredLines.length === 0) {
      split.physical = netSalesMinor;
      split.digital = 0;
    }

    const environment = environmentFor({ siteStatus: site.status, paymentVerified: true });
    for (const cls of ["physical", "digital"] as const) {
      if (split[cls] === 0) continue;
      await recordUsage(tx, {
        orgId: site.orgId,
        siteId: site.id,
        orderId: order.id,
        type: "sale",
        amountMinor: split[cls],
        currency: current.currency,
        productClass: cls,
        environment,
        // Keyed by class as well as order: two classes on one order are two
        // genuine metering events, and one key would swallow the second.
        dedupeKey: `sale:${order.id}:${cls}`,
      });
    }

    // The timeline starts here, so nothing that happens to this order later
    // sits above an unexplained beginning (§18.7).
    await tx.insert(orderEvents).values({
      orderId: order.id,
      type: "placed",
      message: `Order placed and paid via ${current.provider}.`,
      data: {
        rail: current.provider,
        totalMinor: current.totalMinor,
        currency: current.currency,
        paymentReference: input.paymentReference,
      },
      visibility: "customer",
      actorType: "system",
    });

    /**
     * Digital delivery (§18.8), inside the same transaction as the order.
     *
     * A paid order must never exist without the access it was sold. Issuing
     * afterwards means a crash in between leaves a buyer charged for a file
     * they cannot reach, with nothing in the system aware it is missing.
     */
    const delivery = await issueDelivery(tx, {
      orderId: order.id,
      orgId: site.orgId,
      customerId: current.customerId,
      email: current.email,
      items: await deliverableItems(tx, order.id),
    });

    /**
     * Memberships conferred by this order (§18.9), in the same transaction and
     * for the same reason as digital delivery: a paid order must never exist
     * without the access it was sold. Granting afterwards means a crash in
     * between leaves a buyer charged for a membership they do not hold.
     *
     * **Silently skipped for a guest checkout**, which is a real gap rather than
     * an oversight — a membership is held by a `customers` row, and a shopper
     * who never created an account has none to attach it to. The order timeline
     * records that, so the merchant can grant it by hand.
     */
    const memberships = await grantMembershipsForOrder(tx, {
      orderId: order.id,
      siteId: site.id,
      customerId: current.customerId,
      lines,
    });

    if (memberships.granted.length > 0) {
      await tx.insert(orderEvents).values({
        orderId: order.id,
        type: "placed",
        message: `Granted membership: ${memberships.granted.map((g) => g.tierName).join(", ")}.`,
        data: { tiers: memberships.granted },
        visibility: "customer",
        actorType: "system",
      });
    }

    if (memberships.unclaimed.length > 0) {
      await tx.insert(orderEvents).values({
        orderId: order.id,
        type: "placed",
        message:
          `This order includes ${memberships.unclaimed.length} membership(s) that could not be ` +
          "granted because the buyer checked out as a guest. Grant them manually once they " +
          "create an account.",
        data: { tiers: memberships.unclaimed },
        visibility: "internal",
        actorType: "system",
      });
    }

    if (delivery.grants.length > 0 || delivery.licenceKeys.length > 0) {
      await tx.insert(orderEvents).values({
        orderId: order.id,
        type: "placed",
        message:
          `Issued ${delivery.grants.length} download(s) and ` +
          `${delivery.licenceKeys.length} licence key(s).`,
        data: {
          downloads: delivery.grants.length,
          licenceKeys: delivery.licenceKeys.length,
        },
        visibility: "internal",
        actorType: "system",
      });
    }

    /**
     * An empty key pool is the merchant's problem to fix, not the shopper's to
     * absorb — and never a reason to fail a settled payment. It is recorded
     * loudly rather than swallowed, because the buyer is owed something the
     * store currently cannot hand over.
     */
    if (delivery.exhaustedProductIds.length > 0) {
      await tx.insert(orderEvents).values({
        orderId: order.id,
        type: "note",
        message:
          "Licence keys ran out — this order is owed keys that could not be issued. " +
          `Add more keys for product(s) ${delivery.exhaustedProductIds.join(", ")}, ` +
          "then re-issue from the order.",
        data: { exhaustedProductIds: delivery.exhaustedProductIds },
        visibility: "internal",
        actorType: "system",
      });
    }

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
