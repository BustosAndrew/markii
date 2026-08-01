import { and, count, eq, inArray, isNull } from "drizzle-orm";
import {
  collectionProducts,
  db,
  discountRedemptions,
  discounts,
  type Discount,
} from "../db";

/**
 * Discount evaluation (§18.5).
 *
 * Every amount here is derived from the catalog and the stored discount, never
 * from a request body — the §18.4 rule that a client-supplied amount is never
 * trusted applies most sharply to the field whose whole job is reducing what
 * someone pays.
 *
 * The engine is deliberately **explaining** rather than merely arithmetic: a
 * rejected code returns *why* it was rejected. "Invalid code" for an expired
 * one, a below-minimum cart, and a typo are three different problems, and only
 * one of them is the shopper's fault.
 */

/** Why a code did not apply. The shopper sees this, so it has to be true and useful. */
export type DiscountRejection =
  | { code: "not_found"; message: string }
  | { code: "disabled"; message: string }
  | { code: "not_started"; message: string; startsAt: string }
  | { code: "expired"; message: string; endsAt: string }
  | { code: "below_minimum"; message: string; minimumSubtotalMinor: number; subtotalMinor: number }
  | { code: "usage_limit_reached"; message: string }
  | { code: "customer_limit_reached"; message: string }
  | { code: "not_eligible"; message: string }
  | { code: "no_matching_items"; message: string }
  | { code: "does_not_combine"; message: string };

export type AppliedDiscount = {
  discountId: number;
  code: string | null;
  title: string;
  type: Discount["type"];
  /** What it takes off the subtotal. Zero for `free_shipping`, which acts on shipping. */
  amountMinor: number;
  /** True when this discount makes shipping free rather than reducing the subtotal. */
  freeShipping: boolean;
};

export type DiscountEvaluation = {
  applied: AppliedDiscount[];
  rejected: { code: string; reason: DiscountRejection }[];
  totalDiscountMinor: number;
  freeShipping: boolean;
};

/** `active` is the only status that can apply. The rest explain themselves. */
export function statusOf(d: Discount, now = new Date()): "active" | "scheduled" | "expired" | "disabled" {
  if (!d.enabled) return "disabled";
  if (d.startsAt && d.startsAt > now) return "scheduled";
  if (d.endsAt && d.endsAt < now) return "expired";
  return "active";
}

/** How many times a discount has been used. Derived — see the schema comment. */
export async function usedCount(discountId: number, customerId?: number | null): Promise<number> {
  const conds = [eq(discountRedemptions.discountId, discountId)];
  if (customerId != null) conds.push(eq(discountRedemptions.customerId, customerId));
  const [row] = await db
    .select({ c: count() })
    .from(discountRedemptions)
    .where(and(...conds));
  return Number(row?.c ?? 0);
}

/** Counts for a batch of discounts, so a list route is one query rather than N. */
export async function usedCounts(discountIds: number[]): Promise<Map<number, number>> {
  if (discountIds.length === 0) return new Map();
  const rows = await db
    .select({ id: discountRedemptions.discountId, c: count() })
    .from(discountRedemptions)
    .where(inArray(discountRedemptions.discountId, discountIds))
    .groupBy(discountRedemptions.discountId);
  return new Map(rows.map((r) => [r.id, Number(r.c)]));
}

export type PricedLineLite = {
  productId: number;
  lineTotalMinor: number;
};

/**
 * The portion of a cart a discount applies to.
 *
 * An order-scoped discount sees the whole subtotal; a product- or
 * collection-scoped one sees only its own lines. Applying a percentage to the
 * wrong base is the difference between 20% off one item and 20% off the cart.
 */
async function applicableBase(
  d: Discount,
  lines: PricedLineLite[],
): Promise<{ baseMinor: number; matched: boolean }> {
  if (d.appliesToScope === "order") {
    const baseMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    return { baseMinor, matched: baseMinor > 0 };
  }

  let productIds: Set<number>;
  if (d.appliesToScope === "products") {
    productIds = new Set(d.appliesToIds);
  } else {
    // Collection-scoped: resolve membership now rather than storing product ids,
    // so adding a product to a collection extends the sale automatically.
    const rows = d.appliesToIds.length
      ? await db
          .select({ productId: collectionProducts.productId })
          .from(collectionProducts)
          .where(inArray(collectionProducts.collectionId, d.appliesToIds))
      : [];
    productIds = new Set(rows.map((r) => r.productId));
  }

  const baseMinor = lines
    .filter((l) => productIds.has(l.productId))
    .reduce((s, l) => s + l.lineTotalMinor, 0);
  return { baseMinor, matched: baseMinor > 0 };
}

/** What a discount takes off its applicable base. Integer, half-up, never a float. */
export function amountOf(d: Discount, baseMinor: number): number {
  if (d.type === "free_shipping") return 0;
  if (d.type === "percentage") {
    return Math.floor((baseMinor * (d.percentageBps ?? 0) + 5000) / 10000);
  }
  // A fixed discount never exceeds what it applies to — a £20 code on a £5 cart
  // takes off £5, not £20, and certainly never turns the order negative.
  return Math.min(d.valueMinor ?? 0, baseMinor);
}

/** Looks up a code on a store. Case-insensitive: codes are stored upper-cased. */
export async function findByCode(siteId: number, code: string): Promise<Discount | null> {
  const [row] = await db
    .select()
    .from(discounts)
    .where(and(eq(discounts.siteId, siteId), eq(discounts.code, code.trim().toUpperCase())))
    .limit(1);
  return row ?? null;
}

/** Automatic discounts on a store — applied without the shopper typing anything. */
export async function automaticFor(siteId: number): Promise<Discount[]> {
  return db
    .select()
    .from(discounts)
    .where(and(eq(discounts.siteId, siteId), isNull(discounts.code), eq(discounts.enabled, true)));
}

/** Every check that does not depend on what else is already applied. */
async function eligibility(
  d: Discount,
  ctx: { subtotalMinor: number; customerId: number | null; lines: PricedLineLite[]; now: Date },
): Promise<{ ok: true; baseMinor: number } | { ok: false; reason: DiscountRejection }> {
  const status = statusOf(d, ctx.now);
  if (status === "disabled") {
    return { ok: false, reason: { code: "disabled", message: "This code is no longer active." } };
  }
  if (status === "scheduled") {
    return {
      ok: false,
      reason: {
        code: "not_started",
        message: `This code is not active yet.`,
        startsAt: d.startsAt!.toISOString(),
      },
    };
  }
  if (status === "expired") {
    return {
      ok: false,
      reason: {
        code: "expired",
        message: "This code has expired.",
        endsAt: d.endsAt!.toISOString(),
      },
    };
  }

  if (d.minimumSubtotalMinor != null && ctx.subtotalMinor < d.minimumSubtotalMinor) {
    return {
      ok: false,
      reason: {
        code: "below_minimum",
        // Says what is needed, not just that something is wrong.
        message: "This cart is below the minimum for this code.",
        minimumSubtotalMinor: d.minimumSubtotalMinor,
        subtotalMinor: ctx.subtotalMinor,
      },
    };
  }

  if (d.customerEligibility === "specific") {
    if (ctx.customerId == null || !d.eligibleCustomerIds.includes(ctx.customerId)) {
      return {
        ok: false,
        reason: { code: "not_eligible", message: "This code is not available on this account." },
      };
    }
  }

  if (d.usageLimit != null && (await usedCount(d.id)) >= d.usageLimit) {
    return {
      ok: false,
      reason: { code: "usage_limit_reached", message: "This code has been fully redeemed." },
    };
  }
  if (d.usageLimitPerCustomer != null && ctx.customerId != null) {
    if ((await usedCount(d.id, ctx.customerId)) >= d.usageLimitPerCustomer) {
      return {
        ok: false,
        reason: {
          code: "customer_limit_reached",
          message: "You have already used this code the maximum number of times.",
        },
      };
    }
  }

  const { baseMinor, matched } = await applicableBase(d, ctx.lines);
  if (!matched && d.type !== "free_shipping") {
    return {
      ok: false,
      reason: {
        code: "no_matching_items",
        message: "This code does not apply to anything in your cart.",
      },
    };
  }

  return { ok: true, baseMinor };
}

/** Which `combinesWith` flag governs a discount of this shape. */
function kindOf(d: Discount): "product" | "order" | "shipping" {
  if (d.type === "free_shipping") return "shipping";
  return d.appliesToScope === "order" ? "order" : "product";
}

/**
 * Evaluates the codes on a cart plus any automatic discounts.
 *
 * **Stacking is opt-in on both sides.** A second discount only joins the first
 * if *both* say they combine with the other's kind. Defaulting to combinable is
 * how a store wakes up having sold everything at 70% off, so a discount that has
 * not been told it stacks does not.
 */
export async function evaluateDiscounts(input: {
  siteId: number;
  codes: string[];
  lines: PricedLineLite[];
  subtotalMinor: number;
  customerId: number | null;
  now?: Date;
}): Promise<DiscountEvaluation> {
  const now = input.now ?? new Date();
  const applied: AppliedDiscount[] = [];
  const rejected: { code: string; reason: DiscountRejection }[] = [];

  const candidates: { entered: string; discount: Discount }[] = [];
  for (const raw of input.codes) {
    const code = raw.trim().toUpperCase();
    const found = await findByCode(input.siteId, code);
    if (!found) {
      rejected.push({
        code,
        reason: { code: "not_found", message: "That code was not recognised." },
      });
      continue;
    }
    candidates.push({ entered: code, discount: found });
  }

  // Automatic discounts are evaluated after codes: a shopper who typed something
  // should see their own code considered first when the two cannot combine.
  for (const d of await automaticFor(input.siteId)) {
    candidates.push({ entered: d.title, discount: d });
  }

  for (const { entered, discount } of candidates) {
    const verdict = await eligibility(discount, {
      subtotalMinor: input.subtotalMinor,
      customerId: input.customerId,
      lines: input.lines,
      now,
    });
    if (!verdict.ok) {
      if (discount.code) rejected.push({ code: entered, reason: verdict.reason });
      continue;
    }

    if (applied.length > 0) {
      const incoming = kindOf(discount);
      const combinable = applied.every((a) => {
        const existing = candidates.find((c) => c.discount.id === a.discountId)!.discount;
        const existingKind = kindOf(existing);
        const existingAllows =
          incoming === "product"
            ? existing.combinesWithProduct
            : incoming === "order"
              ? existing.combinesWithOrder
              : existing.combinesWithShipping;
        const incomingAllows =
          existingKind === "product"
            ? discount.combinesWithProduct
            : existingKind === "order"
              ? discount.combinesWithOrder
              : discount.combinesWithShipping;
        return existingAllows && incomingAllows;
      });
      if (!combinable) {
        if (discount.code) {
          rejected.push({
            code: entered,
            reason: {
              code: "does_not_combine",
              message: "This code cannot be combined with the discount already on your cart.",
            },
          });
        }
        continue;
      }
    }

    applied.push({
      discountId: discount.id,
      code: discount.code,
      title: discount.title,
      type: discount.type,
      amountMinor: amountOf(discount, verdict.baseMinor),
      freeShipping: discount.type === "free_shipping",
    });
  }

  const totalDiscountMinor = applied.reduce((s, a) => s + a.amountMinor, 0);
  return {
    applied,
    rejected,
    // Belt and braces: even with stacking, a discount can never exceed the cart.
    totalDiscountMinor: Math.min(totalDiscountMinor, input.subtotalMinor),
    freeShipping: applied.some((a) => a.freeShipping),
  };
}

/**
 * Records that a discount was used on an order.
 *
 * Idempotent by the unique key on `(discountId, orderId)`: the completion path
 * is retried by webhooks and agents, and burning a single-use code twice would
 * lock out the next customer.
 */
export async function recordRedemptions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    orderId: number;
    customerId: number | null;
    applied: { discountId: number; amountMinor: number }[];
  },
): Promise<void> {
  for (const a of input.applied) {
    await tx
      .insert(discountRedemptions)
      .values({
        discountId: a.discountId,
        orderId: input.orderId,
        customerId: input.customerId,
        amountMinor: a.amountMinor,
      })
      .onConflictDoNothing({
        target: [discountRedemptions.discountId, discountRedemptions.orderId],
      });
  }
}
