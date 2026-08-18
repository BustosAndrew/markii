import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, notFound } from "../../api";
import { inventoryLedger, locations, products, sites, variants } from "../../db";
import { ownSites, siteScope } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Inventory actions (§18.1).
 *
 * Stock is an **append-only ledger**, never a mutable integer. Every adjustment
 * appends a row; the level is the sum. That is what makes stock reconcilable
 * against a physical count, auditable after the fact, and reversible — the
 * inverse of an adjustment is just another adjustment.
 */

async function ownedVariantAndLocation(
  ctx: ActionContext,
  variantId: number,
  locationId: number,
) {
  if (!ctx.actor.orgId) throw notFound("Variant");

  const [variant] = await ctx.db
    .select({ id: variants.id, siteId: products.siteId, policy: variants.inventoryPolicy })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variants.id, variantId), siteScope(ctx.actor.orgId, products.siteId)))
    .limit(1);
  if (!variant) throw notFound("Variant");

  const [location] = await ctx.db
    .select({ id: locations.id, siteId: locations.siteId })
    .from(locations)
    .innerJoin(sites, eq(sites.id, locations.siteId))
    .where(and(eq(locations.id, locationId), ownSites(ctx.actor.orgId)))
    .limit(1);
  if (!location) throw notFound("Location");

  // Stock lives at a location belonging to the same store as the product.
  if (location.siteId !== variant.siteId) {
    throw badRequest("Location belongs to a different store than the variant");
  }
  return { variant, location };
}

/** Current level for a variant at a location: the sum of its ledger. */
export async function levelFor(ctx: ActionContext, variantId: number, locationId: number) {
  const [row] = await ctx.db
    .select({
      available: sql<string>`coalesce(sum(${inventoryLedger.availableDelta}), 0)`,
      committed: sql<string>`coalesce(sum(${inventoryLedger.committedDelta}), 0)`,
    })
    .from(inventoryLedger)
    .where(
      and(eq(inventoryLedger.variantId, variantId), eq(inventoryLedger.locationId, locationId)),
    );
  return { available: Number(row?.available ?? 0), committed: Number(row?.committed ?? 0) };
}

export const adjustInventory = defineAction({
  id: "inventory.adjust",
  description:
    "Append a stock adjustment for a variant at a location. Positive delta receives stock, " +
    "negative removes it. Never overwrites a total — the level is the sum of all adjustments, " +
    "so mistakes are corrected by appending the inverse rather than editing history.",
  input: z.object({
    variantId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    delta: z.number().int().refine((n) => n !== 0, "delta must not be zero"),
    reason: z.string().min(1).max(200),
  }),
  permission: "catalog.write",
  riskTier: "low",
  /** The inverse entry is a plain adjustment, so undo needs no special path. */
  undoable: true,
  inverse: (recorded) => {
    const original = recorded.input as
      | { variantId?: number; locationId?: number; delta?: number; reason?: string }
      | null;
    if (!original?.variantId || !original.locationId || !original.delta) return null;
    return {
      actionId: "inventory.adjust",
      input: {
        variantId: original.variantId,
        locationId: original.locationId,
        delta: -original.delta,
        reason: `Undo: ${original.reason ?? "adjustment"}`.slice(0, 200),
      },
      /**
       * **Never a conflict.** The level is the sum of an append-only ledger, so
       * the opposite entry is the right correction whatever else has been sold
       * or received since. Comparing the level against what this adjustment left
       * behind would refuse to undo a mistake the moment anyone bought anything
       * — which is exactly when a merchant reaches for undo.
       */
      conflictCheck: "none" as const,
    };
  },
  async run(input, ctx) {
    const { variant } = await ownedVariantAndLocation(ctx, input.variantId, input.locationId);
    const before = await levelFor(ctx, input.variantId, input.locationId);
    const after = before.available + input.delta;

    /**
     * `deny` means "do not sell past zero", so a manual adjustment must not push
     * on-hand stock negative either. `continue` is an explicit choice to oversell
     * and is left alone.
     */
    if (after < 0 && variant.policy === "deny") {
      throw badRequest(
        `Adjustment would leave ${after} in stock; this variant's policy is "deny". ` +
          `Set inventoryPolicy to "continue" to allow negative stock.`,
      );
    }

    await ctx.db.insert(inventoryLedger).values({
      variantId: input.variantId,
      locationId: input.locationId,
      availableDelta: input.delta,
      reason: input.reason,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
    });

    ctx.recordDiff({
      entity: "inventoryLevel",
      entityId: `${input.variantId}@${input.locationId}`,
      path: "available",
      before: before.available,
      after,
    });

    return {
      variantId: input.variantId,
      locationId: input.locationId,
      available: after,
      committed: before.committed,
    };
  },
});

export const createLocation = defineAction({
  id: "inventory.createLocation",
  description: "Create a stock-holding location for a store.",
  input: z.object({
    siteId: z.number().int().positive(),
    name: z.string().min(1).max(120),
    isDefault: z.boolean().default(false),
  }),
  permission: "catalog.write",
  riskTier: "low",
  undoable: false,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Site");
    const [site] = await ctx.db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, input.siteId), ownSites(ctx.actor.orgId)))
      .limit(1);
    if (!site) throw notFound("Site");

    // Exactly one default per store, so a checkout never has to guess.
    if (input.isDefault) {
      await ctx.db
        .update(locations)
        .set({ isDefault: false })
        .where(eq(locations.siteId, input.siteId));
    }

    const [row] = await ctx.db
      .insert(locations)
      .values({ siteId: input.siteId, name: input.name, isDefault: input.isDefault })
      .returning();

    ctx.recordDiff({
      entity: "location",
      entityId: String(row.id),
      path: "name",
      before: null,
      after: row.name,
    });
    return row;
  },
});
