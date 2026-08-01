import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../api";
import { discounts, sites } from "../../db";
import { ownSites, siteScope } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Discount actions (§18.5).
 *
 * `medium` risk throughout: a wrong discount is not a data-corruption bug, it is
 * money leaving on every order until someone notices. Deletion is `high`,
 * because a live code vanishing mid-session is something shoppers experience
 * directly.
 */

async function ownedDiscount(ctx: ActionContext, id: number) {
  if (!ctx.actor.orgId) throw notFound("Discount");
  const [row] = await ctx.db
    .select()
    .from(discounts)
    .where(and(eq(discounts.id, id), siteScope(ctx.actor.orgId, discounts.siteId)))
    .limit(1);
  if (!row) throw notFound("Discount");
  return row;
}

/**
 * A discount must carry the value its type needs, and only that value.
 *
 * Validated as a whole rather than field by field: a `percentage` with a
 * `valueMinor` set is ambiguous about what it takes off, and a `percentage` with
 * no `percentageBps` is a code that silently discounts nothing.
 */
function assertCoherent(d: {
  type: string;
  percentageBps?: number | null;
  valueMinor?: number | null;
  appliesToScope?: string;
  appliesToIds?: number[];
  customerEligibility?: string;
  eligibleCustomerIds?: number[];
  startsAt?: Date | null;
  endsAt?: Date | null;
}) {
  if (d.type === "percentage") {
    if (d.percentageBps == null) throw badRequest("A percentage discount needs percentageBps");
    if (d.valueMinor != null) {
      throw badRequest("A percentage discount must not also set valueMinor");
    }
  }
  if (d.type === "fixed") {
    if (d.valueMinor == null) throw badRequest("A fixed discount needs valueMinor");
    if (d.percentageBps != null) {
      throw badRequest("A fixed discount must not also set percentageBps");
    }
  }
  if (d.type === "free_shipping" && (d.percentageBps != null || d.valueMinor != null)) {
    throw badRequest("A free-shipping discount takes no percentage or value");
  }
  if (d.appliesToScope && d.appliesToScope !== "order" && (d.appliesToIds?.length ?? 0) === 0) {
    throw badRequest(
      `A ${d.appliesToScope}-scoped discount needs at least one id, or it applies to nothing`,
    );
  }
  if (d.customerEligibility === "specific" && (d.eligibleCustomerIds?.length ?? 0) === 0) {
    throw badRequest("A customer-specific discount needs at least one eligible customer");
  }
  if (d.startsAt && d.endsAt && d.startsAt > d.endsAt) {
    throw badRequest("startsAt cannot be after endsAt — this discount could never apply");
  }
}

const shape = {
  code: z.string().min(1).max(60).nullish(),
  title: z.string().min(1).max(200),
  type: z.enum(["percentage", "fixed", "free_shipping"]),
  /** Basis points: 1500 is 15%. Integer, never a float (D31). */
  percentageBps: z.number().int().min(0).max(10000).nullish(),
  valueMinor: z.number().int().min(0).nullish(),
  appliesToScope: z.enum(["order", "products", "collections"]).default("order"),
  appliesToIds: z.array(z.number().int().positive()).max(500).default([]),
  minimumSubtotalMinor: z.number().int().min(0).nullish(),
  customerEligibility: z.enum(["all", "specific"]).default("all"),
  eligibleCustomerIds: z.array(z.number().int().positive()).max(1000).default([]),
  usageLimit: z.number().int().positive().nullish(),
  usageLimitPerCustomer: z.number().int().positive().nullish(),
  combinesWithProduct: z.boolean().default(false),
  combinesWithOrder: z.boolean().default(false),
  combinesWithShipping: z.boolean().default(false),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  enabled: z.boolean().default(true),
};

export const createDiscount = defineAction({
  id: "discounts.create",
  description:
    "Create a discount. Omit `code` for an automatic discount applied without the shopper " +
    "typing anything. Stacking is off by default — set the combinesWith flags deliberately.",
  input: z.object({ siteId: z.number().int().positive(), ...shape }),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Store");
    const { siteId, ...d } = input;

    const [site] = await ctx.db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), ownSites(ctx.actor.orgId)))
      .limit(1);
    if (!site) throw notFound("Store");

    assertCoherent(d);

    // Stored upper-cased so matching is case-insensitive without a functional
    // index, and so the unique key actually prevents "SAVE10" and "save10".
    const code = d.code ? d.code.trim().toUpperCase() : null;
    if (code) {
      const [taken] = await ctx.db
        .select({ id: discounts.id })
        .from(discounts)
        .where(and(eq(discounts.siteId, siteId), eq(discounts.code, code)))
        .limit(1);
      if (taken) throw conflict(`The code "${code}" already exists on this store`);
    }

    const [row] = await ctx.db
      .insert(discounts)
      .values({
        siteId,
        code,
        title: d.title,
        type: d.type,
        percentageBps: d.percentageBps ?? null,
        valueMinor: d.valueMinor ?? null,
        appliesToScope: d.appliesToScope,
        appliesToIds: d.appliesToIds,
        minimumSubtotalMinor: d.minimumSubtotalMinor ?? null,
        customerEligibility: d.customerEligibility,
        eligibleCustomerIds: d.eligibleCustomerIds,
        usageLimit: d.usageLimit ?? null,
        usageLimitPerCustomer: d.usageLimitPerCustomer ?? null,
        combinesWithProduct: d.combinesWithProduct,
        combinesWithOrder: d.combinesWithOrder,
        combinesWithShipping: d.combinesWithShipping,
        startsAt: d.startsAt ?? null,
        endsAt: d.endsAt ?? null,
        enabled: d.enabled,
      })
      .returning();

    ctx.recordDiff({
      entity: "discount",
      entityId: String(row.id),
      path: "created",
      before: null,
      after: row.code ?? row.title,
    });
    return row;
  },
});

export const updateDiscount = defineAction({
  id: "discounts.update",
  description: "Change a discount's value, conditions, window, or availability.",
  input: z.object({
    discountId: z.number().int().positive(),
    code: shape.code,
    title: shape.title.optional(),
    type: shape.type.optional(),
    percentageBps: shape.percentageBps,
    valueMinor: shape.valueMinor,
    appliesToScope: shape.appliesToScope.optional(),
    appliesToIds: z.array(z.number().int().positive()).max(500).optional(),
    minimumSubtotalMinor: shape.minimumSubtotalMinor,
    customerEligibility: shape.customerEligibility.optional(),
    eligibleCustomerIds: z.array(z.number().int().positive()).max(1000).optional(),
    usageLimit: shape.usageLimit,
    usageLimitPerCustomer: shape.usageLimitPerCustomer,
    combinesWithProduct: z.boolean().optional(),
    combinesWithOrder: z.boolean().optional(),
    combinesWithShipping: z.boolean().optional(),
    startsAt: shape.startsAt,
    endsAt: shape.endsAt,
    enabled: z.boolean().optional(),
  }),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: true,
  async run(input, ctx) {
    const { discountId, ...patch } = input;
    const existing = await ownedDiscount(ctx, discountId);

    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length === 0) throw badRequest("No changes supplied");

    if (typeof changes.code === "string") changes.code = changes.code.trim().toUpperCase();

    // Validate the discount as it will be, not just the fields that moved —
    // switching type without clearing the old value is the common way to end up
    // with an ambiguous discount.
    assertCoherent({ ...existing, ...changes } as Parameters<typeof assertCoherent>[0]);

    if (changes.code && changes.code !== existing.code) {
      const [taken] = await ctx.db
        .select({ id: discounts.id })
        .from(discounts)
        .where(and(eq(discounts.siteId, existing.siteId), eq(discounts.code, changes.code as string)))
        .limit(1);
      if (taken) throw conflict(`The code "${changes.code}" already exists on this store`);
    }

    for (const [key, value] of Object.entries(changes)) {
      ctx.recordDiff({
        entity: "discount",
        entityId: String(discountId),
        path: key,
        before: (existing as unknown as Record<string, unknown>)[key] ?? null,
        after: value instanceof Date ? value.toISOString() : value,
      });
    }

    const [row] = await ctx.db
      .update(discounts)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(discounts.id, discountId))
      .returning();
    return row;
  },
});

export const deleteDiscount = defineAction({
  id: "discounts.delete",
  description:
    "Delete a discount. Its redemption history goes with it — to stop a code working while " +
    "keeping the record, disable it instead.",
  input: z.object({ discountId: z.number().int().positive() }),
  permission: "commerce.write",
  /** A live code vanishing mid-session is something shoppers experience directly. */
  riskTier: "high",
  undoable: false,
  async run(input, ctx) {
    const existing = await ownedDiscount(ctx, input.discountId);
    await ctx.db.delete(discounts).where(eq(discounts.id, existing.id));
    ctx.recordDiff({
      entity: "discount",
      entityId: String(existing.id),
      path: "deleted",
      before: existing.code ?? existing.title,
      after: null,
    });
    return { deleted: true, id: existing.id };
  },
});
