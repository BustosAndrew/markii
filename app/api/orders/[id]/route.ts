import { and, asc, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { siteScope } from "@/lib/tenancy";
import {
  customers,
  db,
  digitalAssets,
  downloadGrants,
  fulfillmentLines,
  fulfillments,
  licenceKeys,
  orderEvents,
  orderLines,
  orders,
  refundLines,
  refunds,
} from "@/lib/db";
import { serializeOrders } from "@/lib/queries";

/**
 * `GET /api/orders/:id` (§13, extended by §18.7) — the whole order.
 *
 * Everything a merchant needs to act on an order arrives in one response:
 * itemisation, refunds, shipments, and the timeline. Splitting them across four
 * calls would let a screen show a total that disagrees with the refunds beside
 * it, because each half arrived at a different moment.
 *
 * **Writes are not here.** `orders.refund`, `orders.cancel`, `orders.fulfill`,
 * `orders.addNote`, and `orders.resendConfirmation` are invoked through
 * `POST /api/actions/:id` — no route handler mutates state outside the registry
 * (§22 rule 1).
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { id } = await params;
    const orderId = parseInt(id, 10);
    if (!Number.isFinite(orderId)) throw badRequest("order id must be a number");

    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), siteScope(orgId, orders.siteId)))
      .limit(1);
    if (!order) throw notFound("Order");

    const [serialized] = await serializeOrders([order]);

    /**
     * Who bought it, when the order knows. Scoped again on the way out rather
     * than trusted from the order's own `customerId` — one lookup is not a
     * reason to leave a tenancy boundary to an invariant elsewhere in the file.
     *
     * Null for guest and agent-placed orders, which is a real state: `email` is
     * the copy frozen at checkout and survives the customer's erasure (§18.3).
     */
    const [customer] = order.customerId
      ? await db
          .select({
            id: customers.id,
            email: customers.email,
            firstName: customers.firstName,
            lastName: customers.lastName,
          })
          .from(customers)
          .where(
            and(eq(customers.id, order.customerId), siteScope(orgId, customers.siteId)),
          )
          .limit(1)
      : [];

    const lines = await db
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id))
      .orderBy(asc(orderLines.id));

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, order.id))
      .orderBy(desc(refunds.createdAt));

    const refundLineRows = refundRows.length
      ? await db
          .select({ line: refundLines })
          .from(refundLines)
          .innerJoin(refunds, eq(refunds.id, refundLines.refundId))
          .where(eq(refunds.orderId, order.id))
      : [];

    const fulfillmentRows = await db
      .select()
      .from(fulfillments)
      .where(eq(fulfillments.orderId, order.id))
      .orderBy(desc(fulfillments.createdAt));

    const fulfillmentLineRows = fulfillmentRows.length
      ? await db
          .select({ line: fulfillmentLines })
          .from(fulfillmentLines)
          .innerJoin(fulfillments, eq(fulfillments.id, fulfillmentLines.fulfillmentId))
          .where(eq(fulfillments.orderId, order.id))
      : [];

    const timeline = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.id))
      .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
      .limit(200);

    /** §18.8. What was delivered digitally, and whether it still can be. */
    const grants = await db
      .select({ grant: downloadGrants, asset: digitalAssets })
      .from(downloadGrants)
      .innerJoin(digitalAssets, eq(digitalAssets.id, downloadGrants.assetId))
      .where(eq(downloadGrants.orderId, order.id))
      .orderBy(asc(downloadGrants.id));

    const keys = await db
      .select()
      .from(licenceKeys)
      .where(eq(licenceKeys.orderId, order.id))
      .orderBy(asc(licenceKeys.id));

    return NextResponse.json({
      ...serialized,
      customerId: order.customerId,
      customer: customer
        ? {
            id: customer.id,
            email: customer.email,
            name: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || null,
          }
        : null,
      lines: lines.map((l) => ({
        ...l,
        /** What is still refundable and still to ship, so the UI need not derive it. */
        quantityRefundable: l.quantity - l.quantityRefunded,
        quantityUnfulfilled: Math.max(l.quantity - l.quantityFulfilled - l.quantityRefunded, 0),
        createdAt: l.createdAt.toISOString(),
      })),
      /**
       * Empty for orders placed before §18.7 and for the direct x402 rail's
       * earliest orders — they were never itemised, and inventing lines from
       * today's catalog would show a merchant prices nobody paid.
       */
      itemised: lines.length > 0,
      refunds: refundRows.map((r) => ({
        ...r,
        lines: refundLineRows.filter((x) => x.line.refundId === r.id).map((x) => x.line),
        /**
         * Stated on every refund: Markii recorded this, it did not move the
         * money. Card refunds need a connected Stripe account and x402
         * settlements cannot be reversed at all (§18.7, §20).
         */
        moneyMovedByMarkii: false,
        createdAt: r.createdAt.toISOString(),
      })),
      fulfillments: fulfillmentRows.map((f) => ({
        ...f,
        lines: fulfillmentLineRows
          .filter((x) => x.line.fulfillmentId === f.id)
          .map((x) => x.line),
        /** Merchant-entered. Markii does no carrier integration (`docs/PLAN.md` §3). */
        trackingVerified: false,
        createdAt: f.createdAt.toISOString(),
        updatedAt: f.updatedAt.toISOString(),
      })),
      timeline: timeline.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      downloads: grants.map(({ grant, asset }) => ({
        id: grant.id,
        fileName: asset.fileName,
        sizeBytes: asset.sizeBytes,
        downloadsUsed: grant.downloadCount,
        downloadLimit: grant.downloadLimit,
        expiresAt: grant.expiresAt?.toISOString() ?? null,
        revokedAt: grant.revokedAt?.toISOString() ?? null,
        revokedReason: grant.revokedReason,
        lastDownloadedAt: grant.lastDownloadedAt?.toISOString() ?? null,
        /**
         * The token is **not** returned. It is the buyer's credential, and a
         * merchant screen does not need it to reissue or revoke — those take a
         * grant id. Putting it here would leak the file to anyone who ever saw
         * the dashboard or a support screenshot.
         */
        redeemable: grant.revokedAt == null,
        createdAt: grant.createdAt.toISOString(),
      })),
      licenceKeys: keys.map((k) => ({
        id: k.id,
        key: k.key,
        productId: k.productId,
        assignedAt: k.assignedAt?.toISOString() ?? null,
        revokedAt: k.revokedAt?.toISOString() ?? null,
      })),
      totals: {
        subtotalMinor: order.subtotalMinor,
        discountMinor: order.discountMinor,
        taxMinor: order.taxMinor,
        shippingMinor: order.shippingMinor,
        totalMinor: order.amountCents,
        refundedMinor: order.refundedMinor,
        /** What is left to refund. Never negative — the database checks it too. */
        refundableMinor: Math.max(order.amountCents - order.refundedMinor, 0),
        currency: order.currency,
      },
    });
  },
  { permission: "commerce.read" },
);
