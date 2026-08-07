import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../api";
import {
  db,
  fulfillmentLines,
  fulfillments,
  orderEvents,
  orderLines,
  orders,
  refundLines,
  refunds,
  sites,
  usageRecords,
  type Order,
  type OrderLine,
} from "../../db";
import {
  applyRefundToLines,
  computeRefund,
  financialStatusAfter,
  restockRefundLines,
  type ComputedRefundLine,
} from "../../commerce/refunds";
import { revokeDeliveryForOrder } from "../../commerce/delivery";
import { revokeMembershipsForOrder } from "../../commerce/memberships";
import { allocate } from "../../commerce/allocation";
import { recordUsage } from "../../commerce/orders";
import { classifyProducts, type ProductClass } from "../../commerce/product-class";
import { sendMerchantMail } from "../../email";
import { orderMailContext, storeIdentity } from "../../email/context";
import {
  cancellationNotice,
  orderConfirmation,
  refundNotice,
  shippingNotice,
  type RenderedEmail,
  type TemplateId,
} from "../../email/templates";
import { getIntegration } from "../../integrations";
import { stripeConfigured } from "../../payments";
import { createStripeRefund, refundIdempotencyKey } from "../../payments/stripe-refunds";
import { siteScope } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Order operations (§18.7): refunds, cancellations, manual fulfillment, notes.
 *
 * **Recording what happened and making it happen are different things**, and
 * this file keeps them apart everywhere it matters. Markii never holds merchant
 * funds (`docs/PRICING.md`), so `method: "manual"` is the merchant telling
 * Markii about money they sent back themselves — written down as exactly that,
 * never as a success message for a transfer nobody made.
 *
 * `method: "processor"` now genuinely moves money, but only on the card rail:
 * the refund is created on the merchant's own Stripe account, out of their own
 * balance. x402/USDC settlement stays irreversible with no chargeback path
 * (§20), so that rail still refuses and says why.
 *
 * The same rule governs fulfillment: Markii does no fulfillment logistics
 * (`docs/PLAN.md` §3), so a tracking number is text a merchant typed and is
 * never presented as confirmed by a carrier.
 */

async function ownedOrder(ctx: ActionContext, orderId: number): Promise<Order & { orgId: string }> {
  if (!ctx.actor.orgId) throw notFound("Order");
  const [row] = await ctx.db
    .select({ order: orders, orgId: sites.orgId })
    .from(orders)
    .innerJoin(sites, eq(sites.id, orders.siteId))
    .where(and(eq(orders.id, orderId), siteScope(ctx.actor.orgId, orders.siteId)))
    .limit(1)
    .for("update", { of: orders });
  if (!row) throw notFound("Order");
  return { ...row.order, orgId: row.orgId };
}

function linesOf(ctx: ActionContext, orderId: number): Promise<OrderLine[]> {
  return ctx.db
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId))
    .orderBy(asc(orderLines.id));
}

/** Who did it, captured at write time so the timeline survives staff leaving. */
function actorLabel(ctx: ActionContext): string {
  return `${ctx.actor.type}:${ctx.actor.id}`;
}

async function logEvent(
  ctx: ActionContext,
  entry: {
    orderId: number;
    type:
      | "note"
      | "refunded"
      | "cancelled"
      | "fulfilled"
      | "fulfillment_updated"
      | "email_sent"
      | "email_failed";
    message: string;
    data?: Record<string, unknown>;
    visibility?: "internal" | "customer";
  },
): Promise<void> {
  await ctx.db.insert(orderEvents).values({
    orderId: entry.orderId,
    type: entry.type,
    message: entry.message,
    data: entry.data ?? {},
    visibility: entry.visibility ?? "internal",
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    actorLabel: actorLabel(ctx),
    invocationId: ctx.invocationId,
  });
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/** What a rail did, or would have done on a dry run. */
type ExecutedRefund = { refundId: string | null; status: string };

/**
 * Pushes money back on the rail the order was paid on (§18.7).
 *
 * **Every refusal here names the thing that is missing**, because they need
 * different actions from different people: an unreversible rail is physics, a
 * disconnected Stripe account is the merchant's to reconnect, and absent
 * platform credentials are Markii's problem. Collapsing them into "refund
 * failed" sends a merchant to fix the wrong thing while a shopper waits for
 * their money.
 *
 * Every path that refuses still leaves `method: "manual"` available, so a
 * merchant is never blocked from *recording* a refund they issued themselves.
 */
async function executeProcessorRefund(
  ctx: ActionContext,
  order: Order & { orgId: string },
  input: { amountMinor: number; reason: string; suppliedReference?: string },
): Promise<ExecutedRefund> {
  /**
   * There is no such thing as an x402 refund, and there never will be. An
   * on-chain settlement is final and Markii holds no key that could reverse one
   * — the merchant sends a new transfer from their own wallet and records it.
   */
  if (order.provider === "x402") {
    throw conflict(
      "x402/USDC settlements are final — there is no way to reverse one from Markii. " +
        "Send the refund from the receiving wallet, then record it here with " +
        'method: "manual" and the transaction hash as processorReference.',
    );
  }

  /**
   * A caller-supplied reference means "here is the refund I already made",
   * which is the manual path. Accepting it here would either be ignored or
   * overwritten by Stripe's own id — both of which silently discard something
   * the merchant typed.
   */
  if (input.suppliedReference) {
    throw badRequest(
      'processorReference records a refund you issued yourself — use it with method: "manual". ' +
        'With method: "processor" Markii creates the refund and stores Stripe\'s id for you.',
    );
  }

  if (!stripeConfigured()) {
    throw conflict(
      "Card refunds are not available on this platform yet. Refund in your Stripe dashboard, " +
        'then record it here with method: "manual" and the Stripe refund id.',
    );
  }

  /**
   * The order has to name the payment it is reversing. Orders placed before the
   * card rail existed carry no PaymentIntent, and there is no way to find one
   * after the fact that would not amount to guessing which charge to reverse.
   */
  if (!order.paymentReference) {
    throw conflict(
      "This order has no Stripe payment recorded against it, so there is nothing to reverse " +
        'automatically. Refund it in your Stripe dashboard and record it with method: "manual".',
    );
  }

  const connection = await getIntegration(order.orgId, "stripe");
  if (connection?.status !== "connected" || !connection.config.accountId) {
    /**
     * Under Connect Standard a merchant can revoke Markii's access at any time
     * from their own dashboard — the deauthorization webhook is how we find
     * out. The charge still exists on their account and is still refundable
     * **by them**; it is only Markii that can no longer touch it.
     */
    throw conflict(
      "Markii is not connected to a Stripe account for this store, so it cannot issue the " +
        "refund. Reconnect Stripe in Settings → Payments, or refund in your Stripe dashboard " +
        'and record it here with method: "manual".',
    );
  }

  /**
   * **Nothing may escape the process on a dry run** (§22). Every check above
   * still ran, which is the point of asking — the caller learns whether this
   * refund would work without a shopper being paid back by a preview.
   */
  if (ctx.dryRun) return { refundId: null, status: "not_executed_dry_run" };

  const result = await createStripeRefund({
    accountId: connection.config.accountId,
    paymentIntentId: order.paymentReference,
    amountMinor: input.amountMinor,
    currency: order.currency,
    reason: input.reason,
    orderId: order.id,
    /**
     * Derived from the order's refund state rather than from this invocation,
     * so a retry after a failed commit collides with itself at Stripe instead
     * of paying the shopper twice.
     */
    idempotencyKey: refundIdempotencyKey(order.id, order.refundedMinor, input.amountMinor),
  });

  /**
   * Stripe's own wording, unchanged. "Insufficient funds in your Stripe
   * balance" and "charge has already been refunded" are different problems with
   * different fixes, and the merchant is the one who has to act on either.
   */
  if (!result.ok) throw conflict(`Stripe refused the refund: ${result.reason}`);

  return { refundId: result.refundId, status: result.status };
}

export const refundOrder = defineAction({
  id: "orders.refund",
  description:
    "Refund an order in full or in part. Refund by line (with the units to return and whether " +
    "to restock them) plus any shipping, or by amount for older orders that have no line " +
    "detail. Markii records the refund, returns stock, and meters the reversal against net " +
    'sales. method "manual" means the merchant issued the refund themselves and is telling ' +
    'Markii about it; method "processor" issues it on the rail — supported on card (Stripe ' +
    "Connect, from the merchant's own balance) and refused on x402, whose settlements are final.",
  input: z
    .object({
      orderId: z.number().int().positive(),
      lines: z
        .array(
          z.object({
            orderLineId: z.number().int().positive(),
            quantity: z.number().int().positive(),
            restock: z.boolean().optional(),
          }),
        )
        .max(200)
        .optional(),
      /** Portion of the order's shipping to give back. */
      shippingMinor: z.number().int().min(0).optional(),
      /** Whole-amount refund, allowed only on orders with no line detail. */
      amountMinor: z.number().int().positive().optional(),
      /** Default for lines that do not say. */
      restock: z.boolean().default(true),
      reason: z
        .enum(["requested_by_customer", "duplicate", "fraudulent", "item_unavailable", "other"])
        .default("requested_by_customer"),
      note: z.string().max(2000).optional(),
      /**
       * `manual` records a refund the merchant sent themselves. `processor`
       * asks the rail to make it — card only; x402 refuses with the reason.
       */
      method: z.enum(["manual", "processor"]).default("manual"),
      /**
       * The merchant's own reference for a `manual` refund: a Stripe refund id
       * they issued from their dashboard, or the hash of their return transfer.
       * Refused with `processor`, which produces its own reference.
       */
      processorReference: z.string().max(200).optional(),
      notifyCustomer: z.boolean().default(false),
    })
    .strict(),
  permission: "commerce.write",
  /** Money leaves and stock returns; §22 rule 3 keeps this off any auto-execute path. */
  riskTier: "high",
  /**
   * A refund cannot be undone by deleting the row: the money is gone and the
   * usage record is immutable by design (§17). Correcting one means recording
   * the opposite movement, which is a decision for a human, not an undo button.
   */
  undoable: false,
  async run(input, ctx) {
    const order = await ownedOrder(ctx, input.orderId);

    if (order.status !== "success") {
      throw conflict(
        `Only a paid order can be refunded; this one is "${order.status}". ` +
          "Use orders.cancel for an order that was never paid.",
      );
    }
    if (order.cancelledAt != null) throw conflict("This order was cancelled, not paid");

    const lines = await linesOf(ctx, order.id);

    const [priorShipping] = await ctx.db
      .select({ total: sql<string>`coalesce(sum(${refunds.shippingMinor}), 0)` })
      .from(refunds)
      .where(eq(refunds.orderId, order.id));

    const computed = computeRefund(
      {
        order,
        lines,
        shippingAlreadyRefundedMinor: Number(priorShipping?.total ?? 0),
      },
      { lines: input.lines, shippingMinor: input.shippingMinor, amountMinor: input.amountMinor },
      { restock: input.restock },
    );

    const rail: "stripe" | "x402" | "manual" | "external" =
      order.provider === "x402" ? "x402" : "stripe";

    /**
     * **The money moves here, before anything is written down.**
     *
     * Deliberately not a `ctx.effect()`, even though a Stripe call is exactly
     * the kind of unrollbackable side effect effects exist for. Effects run
     * *after* commit and their failures are logged rather than raised, so a
     * refund queued as an effect would leave a committed refund row, a credited
     * meter, and restocked units behind a transfer that never happened — the
     * precise fabrication `CLAUDE.md` forbids.
     *
     * Calling first inverts the residual risk into the survivable direction: if
     * the transaction fails after Stripe accepted, money moved with nothing
     * recorded. That is visible (the refund is in the merchant's own Stripe
     * dashboard) and self-correcting, because the idempotency key makes the
     * retry return the same refund instead of issuing a second one.
     */
    const executed =
      input.method === "processor"
        ? await executeProcessorRefund(ctx, order, {
            amountMinor: computed.amountMinor,
            reason: input.reason,
            suppliedReference: input.processorReference,
          })
        : null;

    const [refund] = await ctx.db
      .insert(refunds)
      .values({
        orderId: order.id,
        subtotalMinor: computed.subtotalMinor,
        discountMinor: computed.discountMinor,
        taxMinor: computed.taxMinor,
        shippingMinor: computed.shippingMinor,
        amountMinor: computed.amountMinor,
        netSalesMinor: computed.netSalesMinor,
        currency: order.currency,
        reason: input.reason,
        note: input.note ?? null,
        restock: input.restock,
        method: input.method,
        rail,
        processorReference: executed ? executed.refundId : input.processorReference ?? null,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        invocationId: ctx.invocationId,
      })
      .returning();

    const { restocked, unrestockable } = await restockRefundLines(
      ctx.db,
      `restocked by refund ${refund.id}`,
      computed.lines,
      { type: ctx.actor.type, id: ctx.actor.id },
    );
    const restockedSet = new Set(restocked);

    if (computed.lines.length > 0) {
      await ctx.db.insert(refundLines).values(
        computed.lines.map((l: ComputedRefundLine) => ({
          refundId: refund.id,
          orderLineId: l.orderLineId,
          quantity: l.quantity,
          subtotalMinor: l.subtotalMinor,
          discountMinor: l.discountMinor,
          taxMinor: l.taxMinor,
          restocked: restockedSet.has(l.orderLineId),
        })),
      );
      await applyRefundToLines(ctx.db, computed.lines);
    }

    const refundedMinor = order.refundedMinor + computed.amountMinor;
    await ctx.db
      .update(orders)
      .set({
        refundedMinor,
        financialStatus: financialStatusAfter(order.amountCents, refundedMinor),
      })
      .where(eq(orders.id, order.id));

    /**
     * **Net sales, not the amount returned** (`docs/PRICING.md` §4.1, D36). The
     * shopper gets tax and shipping back too, but those were never revenue: the
     * tax belongs to a government and the postage to a carrier, so crediting
     * them against the threshold would hand the merchant meter room they never
     * earned. The sale was metered on the same base; the reversal matches it.
     *
     * Written even when it is zero-valued in effect, and always with the
     * refund's own id as the key: two partial refunds on one order are two real
     * events, and the old `(orderId, type)` key would have silently dropped the
     * second.
     */
    if (computed.netSalesMinor > 0) {
      /**
       * The environment is **read from the sale**, never re-derived. A store
       * that went live after a test order, or was paused after a real one,
       * would otherwise have its reversal metered in a different environment
       * than its sale — the refund would either be dropped from a meter that
       * counted the sale, or subtracted from one that never did. Either leaves
       * the threshold permanently wrong in the merchant's disfavour or ours.
       */
      const sales = await ctx.db
        .select({
          environment: usageRecords.environment,
          productClass: usageRecords.productClass,
          amountMinor: usageRecords.amountMinor,
        })
        .from(usageRecords)
        .where(
          and(eq(usageRecords.orderId, order.id), eq(usageRecords.type, "sale")),
        );

      /**
       * **The reversal is split the same way the sale was**, or it lands on the
       * wrong threshold: physical and digital meter separately
       * (`docs/PRICING.md` §3), and crediting a digital refund against the
       * physical meter would give the merchant room they never earned on one
       * while leaving the other permanently overstated.
       */
      const refundSplit: Record<ProductClass, number> = { physical: 0, digital: 0 };

      if (computed.lines.length > 0) {
        const lineRows = await ctx.db
          .select({ id: orderLines.id, productId: orderLines.productId })
          .from(orderLines)
          .where(
            inArray(
              orderLines.id,
              computed.lines.map((l: ComputedRefundLine) => l.orderLineId),
            ),
          );
        const productByLine = new Map(lineRows.map((r) => [r.id, r.productId]));
        const classOf = await classifyProducts(ctx.db, lineRows.map((r) => r.productId));

        for (const l of computed.lines as ComputedRefundLine[]) {
          const productId = productByLine.get(l.orderLineId) ?? null;
          const cls = (productId != null && classOf.get(productId)) || "physical";
          refundSplit[cls] += l.subtotalMinor - l.discountMinor;
        }
        /**
         * Shipping-only and amount-based components carry no line, so whatever
         * the computed net sales figure holds beyond the lines is apportioned
         * rather than dropped — the reversal must total `netSalesMinor` exactly.
         */
        const remainder =
          computed.netSalesMinor - (refundSplit.physical + refundSplit.digital);
        if (remainder !== 0) refundSplit.physical += remainder;
      } else {
        /**
         * An un-itemised refund names no lines, so it is apportioned across the
         * classes **in the proportion the sale itself was metered**. That keeps
         * a reversal from ever exceeding what a class was credited, which a flat
         * "all physical" fallback could do on a digital-only order.
         */
        const weights = (["physical", "digital"] as const).map((cls) =>
          sales
            .filter((s) => (s.productClass ?? "physical") === cls)
            .reduce((n, s) => n + s.amountMinor, 0),
        );
        const total = weights[0] + weights[1];
        const parts =
          total > 0
            ? allocate(computed.netSalesMinor, weights)
            : [computed.netSalesMinor, 0];
        refundSplit.physical = parts[0];
        refundSplit.digital = parts[1];
      }

      // No sale record means the sale predates metering and was never counted;
      // `test` keeps its reversal out of a total it was never part of.
      const environment = sales[0]?.environment ?? "test";

      for (const cls of ["physical", "digital"] as const) {
        if (refundSplit[cls] === 0) continue;
        await recordUsage(ctx.db, {
          orgId: order.orgId,
          siteId: order.siteId,
          orderId: order.id,
          type: "refund",
          amountMinor: -refundSplit[cls],
          currency: order.currency,
          productClass: cls,
          environment,
          dedupeKey: `refund:${refund.id}:${cls}`,
        });
      }
    }

    /**
     * A refund withdraws digital access (§18.8). Not doing this is the whole
     * digital-goods fraud pattern: buy, download, refund, keep the file.
     *
     * Scoped to the refunded lines when the refund named any, so refunding one
     * ebook out of three does not revoke the other two. A shipping-only refund
     * names no lines and correctly revokes nothing.
     */
    const revocation =
      computed.lines.length > 0
        ? await revokeDeliveryForOrder(ctx.db, order.id, `refunded (refund ${refund.id})`, {
            orderLineIds: computed.lines.map((l) => l.orderLineId),
          })
        : { grantsRevoked: 0, keysReturned: 0 };

    /**
     * The same withdrawal for memberships (§18.9). Closing the fraud pattern for
     * downloads while leaving it open for memberships would only move the hole —
     * a refunded membership that keeps working is the identical trade.
     *
     * Scoped to the refunded lines' products, so refunding a t-shirt from an
     * order that also contained a membership revokes nothing.
     */
    const membershipRevocation =
      /*
       * `order.siteId` is nullable — orders outlive the store they were placed
       * in. There is nothing to revoke in that case: tiers cascade from the
       * site, so they are already gone.
       */
      computed.lines.length > 0 && order.siteId != null
        ? await revokeMembershipsForOrder(ctx.db, {
            orderId: order.id,
            siteId: order.siteId,
            productIds: computed.lines
              .map((l) => l.productId)
              .filter((id): id is number => id != null),
          })
        : { membershipsRevoked: 0, tierNames: [] };

    await logEvent(ctx, {
      orderId: order.id,
      type: "refunded",
      /**
       * The two methods are different facts and the timeline says which. A
       * merchant reading "refunded" needs to know whether Markii moved the money
       * or is recording that they did — and, on the processor path, that Stripe
       * may still report it as `pending` for a day or two before the shopper
       * sees it. Flattening those into one sentence is how a support thread
       * starts.
       */
      message:
        `Refunded ${computed.amountMinor} ${order.currency}` +
        (computed.shippingMinor > 0 ? ` (including ${computed.shippingMinor} shipping)` : "") +
        (executed
          ? ` via Stripe on the ${rail} rail (refund ${executed.refundId ?? "not issued — dry run"}` +
            `, status ${executed.status}).`
          : ` — recorded as issued by the merchant on the ${rail} rail.`),
      data: {
        refundId: refund.id,
        amountMinor: computed.amountMinor,
        netSalesMinor: computed.netSalesMinor,
        taxMinor: computed.taxMinor,
        shippingMinor: computed.shippingMinor,
        restockedLineIds: restocked,
        unrestockableLineIds: unrestockable,
        downloadsRevoked: revocation.grantsRevoked,
        licenceKeysReturned: revocation.keysReturned,
        membershipsRevoked: membershipRevocation.membershipsRevoked,
        membershipTiersRevoked: membershipRevocation.tierNames,
        method: input.method,
        rail,
        ...(executed
          ? { processorRefundId: executed.refundId, processorStatus: executed.status }
          : {}),
      },
      visibility: "customer",
    });

    ctx.recordDiff({
      entity: "order",
      entityId: String(order.id),
      path: "refundedMinor",
      before: order.refundedMinor,
      after: refundedMinor,
    });

    if (input.notifyCustomer) {
      const { storeName, supportEmail } = await storeIdentity(order.siteId, ctx.db);
      queueOrderMail(ctx, {
        orgId: order.orgId,
        orderId: order.id,
        to: order.email,
        template: "refund_notice",
        email: refundNotice({
          order: orderMailContext({ order, lines, storeName, supportEmail }),
          refundedMinor: computed.amountMinor,
          lines: computed.lines.map((l) => ({
            title: lines.find((ol) => ol.id === l.orderLineId)?.title ?? "Item",
            quantity: l.quantity,
          })),
          /**
           * Always false today. Every refund this action writes is `manual` —
           * the merchant reporting money they sent themselves — so the customer
           * is told that, not that their card was credited.
           */
          settled: false,
          rail,
        }),
      });
    }

    return {
      refundId: refund.id,
      amountMinor: computed.amountMinor,
      netSalesMinor: computed.netSalesMinor,
      currency: order.currency,
      refundedMinor,
      financialStatus: financialStatusAfter(order.amountCents, refundedMinor),
      restockedLineIds: restocked,
      /** Lines whose product no longer exists — nothing to return stock to. */
      unrestockableLineIds: unrestockable,
      /** Digital access withdrawn, so a refunded buyer does not keep the file. */
      downloadsRevoked: revocation.grantsRevoked,
      licenceKeysReturned: revocation.keysReturned,
      /**
       * Stated plainly, and now it varies: `false` means Markii wrote the
       * refund down and the merchant moved the money, `true` means Markii
       * issued it on the rail. Every surface that shows a refund reads this
       * rather than assuming, so neither can imply the other happened.
       *
       * A dry run never moves money however it is asked, so it reports `false`.
       */
      moneyMoved: executed?.refundId != null,
      method: input.method,
      rail,
      /** Stripe's id and status, so a `pending` refund is visible as pending. */
      processorRefundId: executed?.refundId ?? null,
      processorStatus: executed?.status ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export const cancelOrder = defineAction({
  id: "orders.cancel",
  description:
    "Cancel an order that has not been paid, releasing any stock it held. A paid order is " +
    "refunded, not cancelled — cancelling one would leave the shopper's money with the " +
    "merchant and no record of what is owed.",
  input: z
    .object({
      orderId: z.number().int().positive(),
      reason: z.string().min(1).max(500),
      restock: z.boolean().default(true),
      notifyCustomer: z.boolean().default(false),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "high",
  undoable: false,
  async run(input, ctx) {
    const order = await ownedOrder(ctx, input.orderId);

    if (order.cancelledAt != null) throw conflict("This order is already cancelled");
    if (order.status === "success") {
      throw conflict(
        "This order is paid. Refund it with orders.refund — cancelling would keep the " +
          "shopper's money with no record of what is owed back.",
      );
    }

    const lines = await linesOf(ctx, order.id);
    let restocked: number[] = [];
    let unrestockable: number[] = [];

    if (input.restock && lines.length > 0) {
      // A cancelled order returns every unit that was not already refunded.
      const toRestock: ComputedRefundLine[] = lines
        .filter((l) => l.quantity - l.quantityRefunded > 0)
        .map((l) => ({
          orderLineId: l.id,
          quantity: l.quantity - l.quantityRefunded,
          subtotalMinor: 0,
          discountMinor: 0,
          taxMinor: 0,
          restock: true,
          variantId: l.variantId,
          productId: l.productId,
          locationId: l.locationId,
        }));
      ({ restocked, unrestockable } = await restockRefundLines(
        ctx.db,
        `restocked by cancellation of order ${order.id}`,
        toRestock,
        { type: ctx.actor.type, id: ctx.actor.id },
      ));
    }

    const cancelledAt = new Date();
    await ctx.db
      .update(orders)
      .set({
        status: "cancel" as const,
        financialStatus: "voided" as const,
        cancelledAt,
        cancelReason: input.reason,
      })
      .where(eq(orders.id, order.id));

    await logEvent(ctx, {
      orderId: order.id,
      type: "cancelled",
      message: `Order cancelled: ${input.reason}`,
      data: { reason: input.reason, restockedLineIds: restocked },
      visibility: "customer",
    });

    ctx.recordDiff({
      entity: "order",
      entityId: String(order.id),
      path: "status",
      before: order.status,
      after: "cancel",
    });

    if (input.notifyCustomer) {
      const { storeName, supportEmail } = await storeIdentity(order.siteId, ctx.db);
      queueOrderMail(ctx, {
        orgId: order.orgId,
        orderId: order.id,
        to: order.email,
        template: "cancellation_notice",
        email: cancellationNotice({
          order: orderMailContext({ order, lines, storeName, supportEmail }),
          reason: input.reason,
          /**
           * Cancellation refuses paid orders outright, so this is normally zero
           * and the template says "you have not been charged". It reads the
           * stored figure rather than assuming, because an order can carry a
           * prior partial refund.
           */
          refundedMinor: order.refundedMinor,
        }),
      });
    }

    return {
      orderId: order.id,
      status: "cancel" as const,
      cancelledAt: cancelledAt.toISOString(),
      restockedLineIds: restocked,
      unrestockableLineIds: unrestockable,
    };
  },
});

// ---------------------------------------------------------------------------
// Fulfillment — manual only
// ---------------------------------------------------------------------------

export const fulfillOrder = defineAction({
  id: "orders.fulfill",
  description:
    "Record a shipment against an order: which units went out, and optionally a carrier name " +
    "and tracking number. **Manual only** — Markii does not buy labels, shop carrier rates, or " +
    "sync tracking, so these values are what the merchant typed and are never verified.",
  input: z
    .object({
      orderId: z.number().int().positive(),
      /** Omit to fulfill everything still outstanding. */
      lines: z
        .array(
          z.object({
            orderLineId: z.number().int().positive(),
            quantity: z.number().int().positive(),
          }),
        )
        .max(200)
        .optional(),
      status: z.enum(["pending", "shipped", "delivered", "cancelled"]).default("shipped"),
      trackingNumber: z.string().max(200).nullish(),
      carrier: z.string().max(120).nullish(),
      trackingUrl: z.url().max(2000).nullish(),
      note: z.string().max(2000).nullish(),
      notifyCustomer: z.boolean().default(false),
    })
    .strict(),
  permission: "commerce.write",
  /** Wrong tracking reaches a shopper immediately, but nothing financial moves. */
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    const order = await ownedOrder(ctx, input.orderId);
    if (order.cancelledAt != null) throw conflict("A cancelled order cannot be fulfilled");

    const lines = await linesOf(ctx, order.id);
    if (lines.length === 0) {
      throw conflict(
        "This order has no line detail, so there is nothing to mark fulfilled. Orders placed " +
          "before §18.7 were not itemised.",
      );
    }

    const outstanding = new Map(
      lines.map((l) => [l.id, l.quantity - l.quantityFulfilled - l.quantityRefunded]),
    );

    const requested =
      input.lines ??
      lines
        .filter((l) => (outstanding.get(l.id) ?? 0) > 0)
        .map((l) => ({ orderLineId: l.id, quantity: outstanding.get(l.id) as number }));

    if (requested.length === 0) {
      throw conflict("Every line on this order is already fulfilled or refunded");
    }

    for (const req of requested) {
      const left = outstanding.get(req.orderLineId);
      if (left == null) throw badRequest(`Order line ${req.orderLineId} is not on this order`);
      if (req.quantity > left) {
        throw conflict(
          `Order line ${req.orderLineId} has ${left} unit(s) left to fulfill; ` +
            `${req.quantity} requested`,
        );
      }
    }

    const [fulfillment] = await ctx.db
      .insert(fulfillments)
      .values({
        orderId: order.id,
        status: input.status,
        trackingNumber: input.trackingNumber ?? null,
        carrier: input.carrier ?? null,
        trackingUrl: input.trackingUrl ?? null,
        note: input.note ?? null,
        notifiedCustomer: false,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        invocationId: ctx.invocationId,
      })
      .returning();

    await ctx.db.insert(fulfillmentLines).values(
      requested.map((r) => ({
        fulfillmentId: fulfillment.id,
        orderLineId: r.orderLineId,
        quantity: r.quantity,
      })),
    );

    for (const r of requested) {
      await ctx.db
        .update(orderLines)
        .set({ quantityFulfilled: sql`${orderLines.quantityFulfilled} + ${r.quantity}` })
        .where(eq(orderLines.id, r.orderLineId));
    }

    /**
     * Recomputed from the lines rather than inferred from "did we just ship
     * everything requested". Refunded units are not outstanding — an order
     * whose remaining item was refunded is finished, and leaving it
     * `partially_fulfilled` sends a merchant looking for a parcel to send.
     */
    const after = await linesOf(ctx, order.id);
    const outstandingAfter = after.reduce(
      (s, l) => s + Math.max(l.quantity - l.quantityFulfilled - l.quantityRefunded, 0),
      0,
    );
    const anyFulfilled = after.some((l) => l.quantityFulfilled > 0);
    const fulfillmentStatus = outstandingAfter === 0
      ? ("fulfilled" as const)
      : anyFulfilled
        ? ("partially_fulfilled" as const)
        : ("unfulfilled" as const);

    await ctx.db.update(orders).set({ fulfillmentStatus }).where(eq(orders.id, order.id));

    await logEvent(ctx, {
      orderId: order.id,
      type: "fulfilled",
      message:
        `Marked ${requested.reduce((s, r) => s + r.quantity, 0)} unit(s) as ${input.status}` +
        (input.carrier ? ` via ${input.carrier}` : "") +
        (input.trackingNumber ? ` (tracking ${input.trackingNumber})` : "") +
        ". Entered by the merchant; not confirmed by a carrier.",
      data: {
        fulfillmentId: fulfillment.id,
        status: input.status,
        carrier: input.carrier ?? null,
        trackingNumber: input.trackingNumber ?? null,
        lines: requested,
      },
      visibility: "customer",
    });

    ctx.recordDiff({
      entity: "order",
      entityId: String(order.id),
      path: "fulfillmentStatus",
      before: order.fulfillmentStatus,
      after: fulfillmentStatus,
    });

    if (input.notifyCustomer) {
      const { storeName, supportEmail } = await storeIdentity(order.siteId, ctx.db);
      const byId = new Map(after.map((l) => [l.id, l]));
      queueOrderMail(ctx, {
        orgId: order.orgId,
        orderId: order.id,
        to: order.email,
        template: "shipping_notice",
        email: shippingNotice({
          order: orderMailContext({ order, lines: after, storeName, supportEmail }),
          carrier: input.carrier ?? null,
          trackingNumber: input.trackingNumber ?? null,
          trackingUrl: input.trackingUrl ?? null,
          shipped: requested.map((r) => ({
            title: byId.get(r.orderLineId)?.title ?? "Item",
            quantity: r.quantity,
          })),
          /**
           * Recomputed status, not "did we ship everything in this request".
           * Telling a shopper the whole order is on its way when half of it is
           * still on a shelf is the version of this email that generates a
           * "where is the rest?" ticket a week later.
           */
          partial: fulfillmentStatus !== "fulfilled",
        }),
        onSent: async () => {
          await ctx.db
            .update(fulfillments)
            .set({ notifiedCustomer: true, updatedAt: new Date() })
            .where(eq(fulfillments.id, fulfillment.id));
        },
      });
    }

    return {
      fulfillmentId: fulfillment.id,
      orderId: order.id,
      status: input.status,
      fulfillmentStatus,
      /** False until an email provider actually accepts the message. */
      customerNotified: false,
      lines: requested,
    };
  },
});

// ---------------------------------------------------------------------------
// Notes and confirmations
// ---------------------------------------------------------------------------

export const addOrderNote = defineAction({
  id: "orders.addNote",
  description:
    "Add a note to an order's timeline. Internal notes are for staff; a customer-visible note " +
    "is shown to the shopper. Notes are append-only — a timeline that can be edited is not a " +
    "record of what happened.",
  input: z
    .object({
      orderId: z.number().int().positive(),
      note: z.string().min(1).max(2000),
      visibility: z.enum(["internal", "customer"]).default("internal"),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "low",
  undoable: false,
  async run(input, ctx) {
    const order = await ownedOrder(ctx, input.orderId);
    await logEvent(ctx, {
      orderId: order.id,
      type: "note",
      message: input.note,
      visibility: input.visibility,
    });
    ctx.recordDiff({
      entity: "order",
      entityId: String(order.id),
      path: "note",
      before: null,
      after: input.note,
    });
    return { orderId: order.id, added: true, visibility: input.visibility };
  },
});

export const resendOrderConfirmation = defineAction({
  id: "orders.resendConfirmation",
  description:
    "Send the order confirmation to the buyer again. Reports whether a provider actually " +
    "accepted the message — merchant mail goes out from the merchant's own verified domain " +
    "via SES, which must be configured before anything can be delivered.",
  input: z
    .object({
      orderId: z.number().int().positive(),
      /** Overrides the address on the order, for a shopper who mistyped theirs. */
      to: z.email().max(255).optional(),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "low",
  undoable: false,
  async run(input, ctx) {
    const order = await ownedOrder(ctx, input.orderId);
    const to = input.to ?? order.email;
    if (!to) {
      throw badRequest(
        "This order has no email address on it — agent-driven x402 orders often carry none. " +
          "Supply one with `to`.",
      );
    }

    const lines = await linesOf(ctx, order.id);
    const { storeName, supportEmail } = await storeIdentity(order.siteId, ctx.db);

    queueOrderMail(ctx, {
      orgId: order.orgId,
      orderId: order.id,
      to,
      template: "order_confirmation",
      email: orderConfirmation(orderMailContext({ order, lines, storeName, supportEmail })),
    });

    return {
      orderId: order.id,
      to,
      /**
       * Queued, not sent. The send runs after this transaction commits, so no
       * email can escape from a rolled-back action — and the outcome lands on
       * the order timeline, which is where a merchant checks whether it worked.
       */
      queued: true,
    };
  },
});

/**
 * Queues merchant mail as a post-commit effect and records the outcome.
 *
 * Two rules meet here. Effects run only after commit, so a rolled-back or
 * dry-run action never sends anything (§22). And a send that no provider
 * accepted is written to the timeline as `email_failed` — SES is not wired yet,
 * so today that is the normal outcome, and a merchant is told rather than shown
 * a confirmation that never left the building.
 */
function queueOrderMail(
  ctx: ActionContext,
  input: {
    orgId: string;
    orderId: number;
    to: string | null;
    template: TemplateId;
    /** Rendered inside the transaction, sent after it commits. */
    email: RenderedEmail;
    onSent?: () => Promise<void>;
  },
): void {
  const subject = input.email.subject;

  if (!input.to) {
    ctx.effect("skip order mail — no address", async () => {
      await recordMailOutcome(ctx, input.orderId, {
        type: "email_failed",
        message: `Could not send "${subject}" — this order has no email address.`,
      });
    });
    return;
  }
  const to = input.to;

  ctx.effect(`order mail: ${subject}`, async () => {
    const result = await sendMerchantMail(input.orgId, {
      to,
      subject,
      html: input.email.html,
      text: input.email.text,
      template: input.template,
      orderId: input.orderId,
    });
    if (result.sent) {
      await input.onSent?.();
      await recordMailOutcome(ctx, input.orderId, {
        type: "email_sent",
        message: `Sent "${subject}" to ${to}.`,
        data: { provider: result.provider, id: result.id, to, template: input.template },
      });
    } else {
      await recordMailOutcome(ctx, input.orderId, {
        type: "email_failed",
        message: `Could not send "${subject}" to ${to}: ${result.reason}`,
        data: { provider: result.provider, reason: result.reason, to, template: input.template },
      });
    }
  });
}

/**
 * Written through the root handle, not `ctx.db`.
 *
 * `ctx.db` is the action's transaction, which has already committed by the time
 * an effect runs — writing to it here would throw and lose the outcome.
 */
async function recordMailOutcome(
  ctx: ActionContext,
  orderId: number,
  entry: { type: "email_sent" | "email_failed"; message: string; data?: Record<string, unknown> },
): Promise<void> {
  await db.insert(orderEvents).values({
    orderId,
    type: entry.type,
    message: entry.message,
    data: entry.data ?? {},
    visibility: "internal",
    actorType: "system",
    actorId: null,
    actorLabel: actorLabel(ctx),
    invocationId: ctx.invocationId,
  });
}
