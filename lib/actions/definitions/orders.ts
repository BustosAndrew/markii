import { and, asc, eq, sql } from "drizzle-orm";
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
import { recordUsage } from "../../commerce/orders";
import { sendMerchantMail } from "../../email";
import { siteScope } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Order operations (§18.7): refunds, cancellations, manual fulfillment, notes.
 *
 * **Recording what happened and making it happen are different things**, and
 * this file keeps them apart everywhere it matters. Markii never holds merchant
 * funds (`docs/PRICING.md`), the card rail is not wired
 * (`lib/payments` reports `configuration_required`), and x402/USDC settlement is
 * irreversible with no chargeback path (§20). So a refund here is normally the
 * merchant telling Markii about money they sent back themselves — and it is
 * written down as exactly that, rather than as a success message for a transfer
 * nobody made.
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

export const refundOrder = defineAction({
  id: "orders.refund",
  description:
    "Refund an order in full or in part. Refund by line (with the units to return and whether " +
    "to restock them) plus any shipping, or by amount for older orders that have no line " +
    "detail. Markii records the refund, returns stock, and meters the reversal against net " +
    'sales — it does **not** move money unless a payment rail is connected, so method "manual" ' +
    "means the merchant issued the refund themselves.",
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
       * asks the rail — which currently refuses rather than pretending.
       */
      method: z.enum(["manual", "processor"]).default("manual"),
      /** Stripe refund id, or the hash of the merchant's return transfer. */
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

    /**
     * The honest refusal. Neither rail can push money back from here: Stripe is
     * not wired, and an on-chain settlement cannot be reversed by the recipient
     * at all. Recording `succeeded` because a row was written would be a success
     * toast for an action that did not happen.
     */
    if (input.method === "processor") {
      throw conflict(
        order.provider === "x402"
          ? "x402/USDC settlements are final — there is no way to reverse one from Markii. " +
              "Send the refund from the receiving wallet, then record it here with " +
              'method: "manual" and the transaction hash as processorReference.'
          : "Automatic card refunds need a connected Stripe account, which this environment " +
              'does not have. Refund in the Stripe dashboard, then record it with method: "manual" ' +
              "and the Stripe refund id as processorReference.",
      );
    }

    const rail: "stripe" | "x402" | "manual" | "external" =
      order.provider === "x402" ? "x402" : "stripe";

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
        method: "manual",
        rail,
        processorReference: input.processorReference ?? null,
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
      const [sale] = await ctx.db
        .select({ environment: usageRecords.environment })
        .from(usageRecords)
        .where(
          and(eq(usageRecords.orderId, order.id), eq(usageRecords.type, "sale")),
        )
        .limit(1);

      await recordUsage(ctx.db, {
        orgId: order.orgId,
        siteId: order.siteId,
        orderId: order.id,
        type: "refund",
        amountMinor: -computed.netSalesMinor,
        currency: order.currency,
        // No sale record means the sale predates metering and was never counted;
        // `test` keeps its reversal out of a total it was never part of.
        environment: sale?.environment ?? "test",
        dedupeKey: `refund:${refund.id}`,
      });
    }

    await logEvent(ctx, {
      orderId: order.id,
      type: "refunded",
      message:
        `Refunded ${computed.amountMinor} ${order.currency}` +
        (computed.shippingMinor > 0 ? ` (including ${computed.shippingMinor} shipping)` : "") +
        ` — recorded as issued by the merchant on the ${rail} rail.`,
      data: {
        refundId: refund.id,
        amountMinor: computed.amountMinor,
        netSalesMinor: computed.netSalesMinor,
        taxMinor: computed.taxMinor,
        shippingMinor: computed.shippingMinor,
        restockedLineIds: restocked,
        unrestockableLineIds: unrestockable,
        method: "manual",
        rail,
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
      queueOrderMail(ctx, {
        orgId: order.orgId,
        orderId: order.id,
        to: order.email,
        subject: `Refund issued for order #${order.id}`,
        text:
          `A refund of ${computed.amountMinor} ${order.currency} has been issued for order ` +
          `#${order.id}.` + (input.note ? `\n\n${input.note}` : ""),
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
      /** Stated plainly: Markii wrote this down, it did not move the money. */
      moneyMoved: false,
      method: "manual" as const,
      rail,
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
      queueOrderMail(ctx, {
        orgId: order.orgId,
        orderId: order.id,
        to: order.email,
        subject: `Order #${order.id} was cancelled`,
        text: `Order #${order.id} has been cancelled.\n\n${input.reason}`,
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
      queueOrderMail(ctx, {
        orgId: order.orgId,
        orderId: order.id,
        to: order.email,
        subject: `Your order #${order.id} has shipped`,
        text:
          `Order #${order.id} is on its way.` +
          (input.carrier ? `\n\nCarrier: ${input.carrier}` : "") +
          (input.trackingNumber ? `\nTracking: ${input.trackingNumber}` : "") +
          (input.trackingUrl ? `\n${input.trackingUrl}` : ""),
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
    const body =
      `Order #${order.id}\n\n` +
      (lines.length > 0
        ? lines.map((l) => `${l.quantity} × ${l.title} — ${l.totalMinor} ${order.currency}`).join("\n")
        : `${order.quantity} item(s)`) +
      `\n\nTotal: ${order.amountCents} ${order.currency}`;

    queueOrderMail(ctx, {
      orgId: order.orgId,
      orderId: order.id,
      to,
      subject: `Your order #${order.id}`,
      text: body,
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
    subject: string;
    text: string;
    onSent?: () => Promise<void>;
  },
): void {
  if (!input.to) {
    ctx.effect("skip order mail — no address", async () => {
      await recordMailOutcome(ctx, input.orderId, {
        type: "email_failed",
        message: `Could not send "${input.subject}" — this order has no email address.`,
      });
    });
    return;
  }
  const to = input.to;

  ctx.effect(`order mail: ${input.subject}`, async () => {
    const result = await sendMerchantMail(input.orgId, {
      to,
      subject: input.subject,
      text: input.text,
    });
    if (result.sent) {
      await input.onSent?.();
      await recordMailOutcome(ctx, input.orderId, {
        type: "email_sent",
        message: `Sent "${input.subject}" to ${to}.`,
        data: { provider: result.provider, id: result.id, to },
      });
    } else {
      await recordMailOutcome(ctx, input.orderId, {
        type: "email_failed",
        message: `Could not send "${input.subject}" to ${to}: ${result.reason}`,
        data: { provider: result.provider, reason: result.reason, to },
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
