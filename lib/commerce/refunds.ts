import { eq, sql } from "drizzle-orm";
import { badRequest, conflict } from "../api";
import {
  inventoryLedger,
  orderLines,
  products,
  type DbHandle,
  type Order,
  type OrderLine,
} from "../db";
import { shareOfUnits } from "./allocation";

/**
 * Refund arithmetic (§18.7) — pure, so it can be tested without a database.
 *
 * Two things make this more than subtraction.
 *
 * **The meter uses a different base than the refund.** `docs/PRICING.md` §4.1
 * defines net sales as line totals minus discounts, *excluding* tax and
 * shipping. So a £50 refund containing £4 of VAT and £5 of postage returns £50
 * to the shopper and meters −£41. Metering the £50 would credit a merchant for
 * tax they are remitting to a government and postage they already paid a
 * carrier — worst for whoever ships the most (D36).
 *
 * **Discount and tax were allocated, not calculated.** They sit on the line as
 * a whole, so refunding some of its units takes a proportional slice, computed
 * cumulatively so a line refunded in pieces still returns exactly its total —
 * see `lib/commerce/allocation.ts`.
 */

export type RefundLineRequest = {
  orderLineId: number;
  quantity: number;
  /** Put the units back into sellable stock. Not appropriate for damaged returns. */
  restock?: boolean;
};

/** One line's share of a refund, priced. */
export type ComputedRefundLine = {
  orderLineId: number;
  quantity: number;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  restock: boolean;
  /** Carried through so the caller can return stock without re-reading the line. */
  variantId: number | null;
  productId: number | null;
  locationId: number | null;
};

export type ComputedRefund = {
  lines: ComputedRefundLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  /** What the shopper gets back. */
  amountMinor: number;
  /** What reaches the threshold meter, as a positive number. Negated at write time. */
  netSalesMinor: number;
};

/** Shipping already refunded across an order's earlier refunds. */
export type RefundContext = {
  order: Pick<
    Order,
    "amountCents" | "refundedMinor" | "shippingMinor" | "subtotalMinor" | "discountMinor" | "taxMinor"
  >;
  lines: OrderLine[];
  shippingAlreadyRefundedMinor: number;
};

/**
 * Prices a refund request against what the order has already given back.
 *
 * Refuses rather than clamps. A merchant who asked to refund three units of a
 * two-unit line has made a mistake worth surfacing; silently refunding two and
 * reporting success is the kind of quiet divergence between what was asked and
 * what happened that this codebase's no-fabrication rule exists to prevent.
 */
export function computeRefund(
  ctx: RefundContext,
  request: { lines?: RefundLineRequest[]; shippingMinor?: number; amountMinor?: number },
  defaults: { restock: boolean },
): ComputedRefund {
  const byId = new Map(ctx.lines.map((l) => [l.id, l]));
  const requested = request.lines ?? [];

  /**
   * Orders placed before §18.7 have no itemisation, and orders on the direct
   * x402 rail carry no tax or shipping at all. `amountMinor` exists for exactly
   * those: with tax and shipping both zero, the whole refund *is* net sales, so
   * no allocation has to be invented to meter it correctly. It is refused on an
   * itemised order, where guessing which lines the money came from would put
   * the wrong figure into the meter and leave the line quantities untouched.
   */
  if (request.amountMinor != null) {
    if (requested.length > 0) {
      throw badRequest("Refund by line or by amount, not both");
    }
    if (ctx.lines.length > 0) {
      throw badRequest(
        "This order is itemised, so refund it by line. An amount alone cannot say which " +
          "units to restock, or how much of the order's tax and discount the money included — " +
          "and a guess there is metered as revenue that never existed.",
      );
    }
    if (ctx.order.taxMinor !== 0 || ctx.order.shippingMinor !== 0) {
      throw badRequest(
        "This order has tax or shipping but no line detail, so the refund cannot be split " +
          "into what does and does not count as net sales.",
      );
    }
    const amount = request.amountMinor;
    if (amount <= 0) throw badRequest("Refund amount must be positive");
    assertWithinRemaining(ctx, amount);
    return {
      lines: [],
      subtotalMinor: amount,
      discountMinor: 0,
      taxMinor: 0,
      shippingMinor: 0,
      amountMinor: amount,
      netSalesMinor: amount,
    };
  }

  const shippingMinor = request.shippingMinor ?? 0;
  if (shippingMinor < 0) throw badRequest("shippingMinor cannot be negative");
  const shippingRemaining = ctx.order.shippingMinor - ctx.shippingAlreadyRefundedMinor;
  if (shippingMinor > shippingRemaining) {
    throw badRequest(
      `Only ${shippingRemaining} of shipping is left to refund on this order; ${shippingMinor} requested`,
    );
  }

  if (requested.length === 0 && shippingMinor === 0) {
    throw badRequest("A refund must cover at least one line or some shipping");
  }

  const seen = new Set<number>();
  const lines: ComputedRefundLine[] = [];
  for (const req of requested) {
    if (seen.has(req.orderLineId)) {
      throw badRequest(`Order line ${req.orderLineId} appears twice in one refund`);
    }
    seen.add(req.orderLineId);

    const line = byId.get(req.orderLineId);
    if (!line) throw badRequest(`Order line ${req.orderLineId} is not on this order`);
    if (req.quantity <= 0) throw badRequest("Refund quantity must be positive");

    const remaining = line.quantity - line.quantityRefunded;
    if (req.quantity > remaining) {
      throw conflict(
        `"${line.title}" has ${remaining} unit(s) left to refund; ${req.quantity} requested`,
      );
    }

    lines.push({
      orderLineId: line.id,
      quantity: req.quantity,
      subtotalMinor: shareOfUnits(
        line.subtotalMinor,
        line.quantityRefunded,
        req.quantity,
        line.quantity,
      ),
      discountMinor: shareOfUnits(
        line.discountMinor,
        line.quantityRefunded,
        req.quantity,
        line.quantity,
      ),
      taxMinor: shareOfUnits(line.taxMinor, line.quantityRefunded, req.quantity, line.quantity),
      restock: req.restock ?? defaults.restock,
      variantId: line.variantId,
      productId: line.productId,
      locationId: line.locationId,
    });
  }

  const subtotalMinor = lines.reduce((s, l) => s + l.subtotalMinor, 0);
  const discountMinor = lines.reduce((s, l) => s + l.discountMinor, 0);
  const taxMinor = lines.reduce((s, l) => s + l.taxMinor, 0);
  const amountMinor = subtotalMinor - discountMinor + taxMinor + shippingMinor;

  if (amountMinor <= 0) {
    throw badRequest("This refund comes to nothing — every unit selected was fully discounted");
  }
  assertWithinRemaining(ctx, amountMinor);

  return {
    lines,
    subtotalMinor,
    discountMinor,
    taxMinor,
    shippingMinor,
    amountMinor,
    /** Tax and shipping deliberately excluded — `docs/PRICING.md` §4.1, D36. */
    netSalesMinor: subtotalMinor - discountMinor,
  };
}

/**
 * The backstop the line arithmetic cannot provide on its own: even a
 * correctly-priced set of lines must never push total refunds past what the
 * shopper actually paid.
 */
function assertWithinRemaining(ctx: RefundContext, amountMinor: number): void {
  const remaining = ctx.order.amountCents - ctx.order.refundedMinor;
  if (amountMinor > remaining) {
    throw conflict(
      `Refunding ${amountMinor} would exceed the ${remaining} left on this order ` +
        `(paid ${ctx.order.amountCents}, already refunded ${ctx.order.refundedMinor}).`,
    );
  }
}

/**
 * Returns refunded units to sellable stock.
 *
 * A variant-backed line appends to the ledger at the location the stock left
 * from — restocking a Berlin return into a London warehouse it never reached
 * makes both counts wrong. A variant-less product still has only the legacy
 * `products.stock` counter, so that is what moves; a line with neither is
 * reported back rather than silently skipped, because "we restocked it" and
 * "there was nowhere to restock it to" are different facts.
 */
export async function restockRefundLines(
  tx: DbHandle,
  reason: string,
  lines: ComputedRefundLine[],
  actor: { type: "user" | "agent" | "token" | "system"; id: string | null },
): Promise<{ restocked: number[]; unrestockable: number[] }> {
  const restocked: number[] = [];
  const unrestockable: number[] = [];

  for (const line of lines) {
    if (!line.restock) continue;

    if (line.variantId != null && line.locationId != null) {
      await tx.insert(inventoryLedger).values({
        variantId: line.variantId,
        locationId: line.locationId,
        availableDelta: line.quantity,
        reason,
        actorType: actor.type,
        actorId: actor.id,
      });
      restocked.push(line.orderLineId);
    } else if (line.productId != null) {
      await tx
        .update(products)
        .set({ stock: sql`${products.stock} + ${line.quantity}`, updatedAt: new Date() })
        .where(eq(products.id, line.productId));
      restocked.push(line.orderLineId);
    } else {
      // The product was deleted after the sale. Nothing to put stock back into.
      unrestockable.push(line.orderLineId);
    }
  }

  return { restocked, unrestockable };
}

/**
 * Adds a refund's units to the lines it covered.
 *
 * The database's `order_lines_refunded_within_quantity` check is the real
 * guard: `computeRefund` reads the current counts and this increments them, and
 * between those two moments a second refund can land. The check turns that race
 * into a failed transaction rather than a line refunded twice.
 */
export async function applyRefundToLines(tx: DbHandle, lines: ComputedRefundLine[]): Promise<void> {
  for (const line of lines) {
    await tx
      .update(orderLines)
      .set({ quantityRefunded: sql`${orderLines.quantityRefunded} + ${line.quantity}` })
      .where(eq(orderLines.id, line.orderLineId));
  }
}

/**
 * Where an order stands financially after a refund.
 *
 * `refunded` is by amount rather than by units, because a shipping-only refund
 * moves money without touching a single line, and a merchant reading "partially
 * refunded" wants to know money went back — not how it was itemised.
 */
export function financialStatusAfter(
  paidMinor: number,
  refundedMinor: number,
): "paid" | "partially_refunded" | "refunded" {
  if (refundedMinor <= 0) return "paid";
  if (refundedMinor >= paidMinor) return "refunded";
  return "partially_refunded";
}
