import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { badRequest, notFound } from "../../api";
import { shippingRates, shippingZones, sites, taxSettings } from "../../db";
import { ownSites, siteScope } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Shipping and tax rate configuration (§18.6).
 *
 * Rate **configuration**, not logistics: carrier rate shopping, label purchase,
 * and tracking sync are permanently out of scope (`docs/PLAN.md` §3).
 *
 * These are `medium` risk rather than `low`. A wrong shipping rate does not
 * corrupt data, but it is charged to every shopper until someone notices, and a
 * wrong tax rate is a liability the merchant carries — not a record they can
 * simply edit back.
 */

async function ownedSite(ctx: ActionContext, siteId: number) {
  if (!ctx.actor.orgId) throw notFound("Store");
  const [site] = await ctx.db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, siteId), ownSites(ctx.actor.orgId)))
    .limit(1);
  if (!site) throw notFound("Store");
  return site;
}

async function ownedZone(ctx: ActionContext, zoneId: number) {
  if (!ctx.actor.orgId) throw notFound("Shipping zone");
  const [zone] = await ctx.db
    .select()
    .from(shippingZones)
    .where(and(eq(shippingZones.id, zoneId), siteScope(ctx.actor.orgId, shippingZones.siteId)))
    .limit(1);
  if (!zone) throw notFound("Shipping zone");
  return zone;
}

const countryList = z.array(z.string().length(2).regex(/^[A-Za-z]{2}$/)).max(250);

export const createShippingZone = defineAction({
  id: "shipping.createZone",
  description:
    "Create a shipping zone — the set of destinations one group of rates applies to. " +
    "A zone with no countries is the store's catch-all for everywhere else.",
  input: z.object({
    siteId: z.number().int().positive(),
    name: z.string().min(1).max(120),
    countries: countryList.default([]),
    provinces: z.array(z.string().min(1).max(10)).max(200).default([]),
  }),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);

    // A province list without a country would match nothing, which looks like a
    // working zone until a shopper's rates silently come back empty.
    if (input.provinces.length > 0 && input.countries.length === 0) {
      throw badRequest("A zone with provinces must also name at least one country");
    }

    const [row] = await ctx.db
      .insert(shippingZones)
      .values({
        siteId: input.siteId,
        name: input.name,
        countries: input.countries.map((c) => c.toUpperCase()),
        provinces: input.provinces.map((p) => p.toUpperCase()),
      })
      .returning();

    ctx.recordDiff({
      entity: "shippingZone",
      entityId: String(row.id),
      path: "created",
      before: null,
      after: row.name,
    });
    return row;
  },
});

export const updateShippingZone = defineAction({
  id: "shipping.updateZone",
  description: "Rename a shipping zone or change the destinations it covers.",
  input: z.object({
    zoneId: z.number().int().positive(),
    name: z.string().min(1).max(120).optional(),
    countries: countryList.optional(),
    provinces: z.array(z.string().min(1).max(10)).max(200).optional(),
  }),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: true,
  async run(input, ctx) {
    const { zoneId, ...patch } = input;
    const zone = await ownedZone(ctx, zoneId);

    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.countries !== undefined) changes.countries = patch.countries.map((c) => c.toUpperCase());
    if (patch.provinces !== undefined) changes.provinces = patch.provinces.map((p) => p.toUpperCase());
    if (Object.keys(changes).length === 0) throw badRequest("No changes supplied");

    const countries = (changes.countries as string[]) ?? zone.countries;
    const provinces = (changes.provinces as string[]) ?? zone.provinces;
    if (provinces.length > 0 && countries.length === 0) {
      throw badRequest("A zone with provinces must also name at least one country");
    }

    for (const [key, value] of Object.entries(changes)) {
      ctx.recordDiff({
        entity: "shippingZone",
        entityId: String(zoneId),
        path: key,
        before: (zone as Record<string, unknown>)[key] ?? null,
        after: value,
      });
    }

    const [row] = await ctx.db
      .update(shippingZones)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(shippingZones.id, zoneId))
      .returning();
    return row;
  },
});

export const deleteShippingZone = defineAction({
  id: "shipping.deleteZone",
  description:
    "Delete a shipping zone and every rate in it. Carts destined for that zone stop being " +
    "quotable, so checkout refuses them rather than shipping for free.",
  input: z.object({ zoneId: z.number().int().positive() }),
  permission: "commerce.write",
  /** Removes rates shoppers are actively being quoted. */
  riskTier: "high",
  undoable: false,
  async run(input, ctx) {
    const zone = await ownedZone(ctx, input.zoneId);
    await ctx.db.delete(shippingZones).where(eq(shippingZones.id, zone.id));
    ctx.recordDiff({
      entity: "shippingZone",
      entityId: String(zone.id),
      path: "deleted",
      before: zone.name,
      after: null,
    });
    return { deleted: true, id: zone.id };
  },
});

/**
 * Rate bounds are validated as a pair, not field by field.
 *
 * `min > max` is a rate that can never apply — it looks configured in the
 * dashboard and quietly quotes nothing, which is worse than being rejected.
 */
const rateShape = {
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  type: z.enum(["flat", "weight_based", "price_based", "free_over_threshold"]),
  priceMinor: z.number().int().min(0),
  minWeightGrams: z.number().int().min(0).nullish(),
  maxWeightGrams: z.number().int().min(0).nullish(),
  minSubtotalMinor: z.number().int().min(0).nullish(),
  maxSubtotalMinor: z.number().int().min(0).nullish(),
  enabled: z.boolean().default(true),
  position: z.number().int().min(0).default(0),
};

function assertCoherent(r: {
  type: string;
  priceMinor?: number | null;
  minWeightGrams?: number | null;
  maxWeightGrams?: number | null;
  minSubtotalMinor?: number | null;
  maxSubtotalMinor?: number | null;
}) {
  if (r.minWeightGrams != null && r.maxWeightGrams != null && r.minWeightGrams > r.maxWeightGrams) {
    throw badRequest("minWeightGrams cannot exceed maxWeightGrams — this rate could never apply");
  }
  if (
    r.minSubtotalMinor != null &&
    r.maxSubtotalMinor != null &&
    r.minSubtotalMinor > r.maxSubtotalMinor
  ) {
    throw badRequest("minSubtotalMinor cannot exceed maxSubtotalMinor — this rate could never apply");
  }
  if (r.type === "free_over_threshold" && r.minSubtotalMinor == null) {
    throw badRequest("A free-over-threshold rate needs minSubtotalMinor — the threshold itself");
  }
  if (r.type === "free_over_threshold" && (r.priceMinor ?? 0) !== 0) {
    // The rate is only offered once the threshold is met, so a non-zero price
    // here would never be charged. Refusing it is better than storing a number
    // that silently does nothing.
    throw badRequest(
      "A free-over-threshold rate must have priceMinor 0 — it is only offered once its " +
        "threshold is met. For a rate that costs money below a threshold and less above it, " +
        "create two price-based rates.",
    );
  }
  if (r.type === "weight_based" && r.minWeightGrams == null && r.maxWeightGrams == null) {
    throw badRequest("A weight-based rate needs at least one weight bound");
  }
  if (r.type === "price_based" && r.minSubtotalMinor == null && r.maxSubtotalMinor == null) {
    throw badRequest("A price-based rate needs at least one subtotal bound");
  }
}

export const createShippingRate = defineAction({
  id: "shipping.createRate",
  description:
    "Add a rate to a zone. Flat charges one price; weight-based and price-based apply within " +
    "their bounds; free-over-threshold is free once the subtotal reaches minSubtotalMinor.",
  input: z.object({ zoneId: z.number().int().positive(), ...rateShape }),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    const { zoneId, ...rate } = input;
    await ownedZone(ctx, zoneId);
    assertCoherent(rate);

    const [row] = await ctx.db
      .insert(shippingRates)
      .values({
        zoneId,
        name: rate.name,
        description: rate.description ?? null,
        type: rate.type,
        priceMinor: rate.priceMinor,
        minWeightGrams: rate.minWeightGrams ?? null,
        maxWeightGrams: rate.maxWeightGrams ?? null,
        minSubtotalMinor: rate.minSubtotalMinor ?? null,
        maxSubtotalMinor: rate.maxSubtotalMinor ?? null,
        enabled: rate.enabled,
        position: rate.position,
      })
      .returning();

    ctx.recordDiff({
      entity: "shippingRate",
      entityId: String(row.id),
      path: "created",
      before: null,
      after: `${row.name} @ ${row.priceMinor}`,
    });
    return row;
  },
});

export const updateShippingRate = defineAction({
  id: "shipping.updateRate",
  description: "Change a shipping rate's price, bounds, or availability.",
  input: z.object({
    rateId: z.number().int().positive(),
    name: rateShape.name.optional(),
    description: rateShape.description,
    type: rateShape.type.optional(),
    priceMinor: rateShape.priceMinor.optional(),
    minWeightGrams: rateShape.minWeightGrams,
    maxWeightGrams: rateShape.maxWeightGrams,
    minSubtotalMinor: rateShape.minSubtotalMinor,
    maxSubtotalMinor: rateShape.maxSubtotalMinor,
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  }),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Shipping rate");
    const { rateId, ...patch } = input;

    const [existing] = await ctx.db
      .select({ rate: shippingRates })
      .from(shippingRates)
      .innerJoin(shippingZones, eq(shippingZones.id, shippingRates.zoneId))
      .where(
        and(
          eq(shippingRates.id, rateId),
          siteScope(ctx.actor.orgId, shippingZones.siteId),
        ),
      )
      .limit(1);
    if (!existing) throw notFound("Shipping rate");

    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(changes).length === 0) throw badRequest("No changes supplied");

    // Validate the rate as it will be, not just the fields that changed.
    assertCoherent({ ...existing.rate, ...changes } as Parameters<typeof assertCoherent>[0]);

    for (const [key, value] of Object.entries(changes)) {
      ctx.recordDiff({
        entity: "shippingRate",
        entityId: String(rateId),
        path: key,
        before: (existing.rate as unknown as Record<string, unknown>)[key] ?? null,
        after: value,
      });
    }

    const [row] = await ctx.db
      .update(shippingRates)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(shippingRates.id, rateId))
      .returning();
    return row;
  },
});

export const deleteShippingRate = defineAction({
  id: "shipping.deleteRate",
  description: "Remove a shipping rate. Shoppers who selected it are re-quoted at checkout.",
  input: z.object({ rateId: z.number().int().positive() }),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Shipping rate");
    const [existing] = await ctx.db
      .select({ rate: shippingRates })
      .from(shippingRates)
      .innerJoin(shippingZones, eq(shippingZones.id, shippingRates.zoneId))
      .where(
        and(eq(shippingRates.id, input.rateId), siteScope(ctx.actor.orgId, shippingZones.siteId)),
      )
      .limit(1);
    if (!existing) throw notFound("Shipping rate");

    await ctx.db.delete(shippingRates).where(eq(shippingRates.id, input.rateId));
    ctx.recordDiff({
      entity: "shippingRate",
      entityId: String(input.rateId),
      path: "deleted",
      before: existing.rate.name,
      after: null,
    });
    return { deleted: true, id: input.rateId };
  },
});

export const updateTaxSettings = defineAction({
  id: "tax.updateSettings",
  description:
    "Set how a store handles tax. `none` adds no tax line; `manual` uses the merchant's own " +
    "rates; `stripe` uses Stripe Tax. Markii never decides what a merchant owes — this records " +
    "what they told us.",
  input: z.object({
    siteId: z.number().int().positive(),
    provider: z.enum(["none", "manual", "stripe"]).optional(),
    pricesIncludeTax: z.boolean().optional(),
    manualRates: z
      .array(
        z.object({
          country: z.string().length(2).regex(/^[A-Za-z]{2}$/),
          province: z.string().min(1).max(10).nullish(),
          /** Basis points: 875 is 8.75%. Capped at 100% — above that is a typo. */
          rateBps: z.number().int().min(0).max(10000),
          name: z.string().min(1).max(120),
        }),
      )
      .max(200)
      .optional(),
    defaultTaxCode: z.string().max(60).nullish(),
    registrations: z.array(z.string().min(1).max(60)).max(200).optional(),
  }),
  permission: "commerce.write",
  /**
   * Higher than shipping: an incorrect tax rate is charged to every shopper and
   * becomes a liability the merchant cannot simply edit away afterwards.
   */
  riskTier: "high",
  undoable: true,
  async run(input, ctx) {
    const { siteId, ...patch } = input;
    await ownedSite(ctx, siteId);

    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length === 0) throw badRequest("No changes supplied");

    if (patch.manualRates) {
      // Normalized on the way in so `rateFor` can match on exact case and a
      // merchant typing "us" gets the same rate as one typing "US".
      changes.manualRates = patch.manualRates.map((r) => ({
        country: r.country.toUpperCase(),
        province: r.province?.toUpperCase() ?? null,
        rateBps: r.rateBps,
        name: r.name,
      }));
    }

    // `manual` with no rates quotes nothing and blocks every checkout. Refusing
    // it here is better than a store discovering it from a shopper.
    const [current] = await ctx.db
      .select()
      .from(taxSettings)
      .where(eq(taxSettings.siteId, siteId))
      .limit(1);
    const nextProvider = (changes.provider as string) ?? current?.provider ?? "none";
    const nextRates = (changes.manualRates as unknown[]) ?? current?.manualRates ?? [];
    if (nextProvider === "manual" && nextRates.length === 0) {
      throw badRequest(
        'Tax provider "manual" needs at least one rate — otherwise every checkout is refused ' +
          "for having no calculable tax.",
      );
    }

    const [row] = await ctx.db
      .insert(taxSettings)
      .values({ siteId, ...changes, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: taxSettings.siteId,
        set: { ...changes, updatedAt: new Date() },
      })
      .returning();

    for (const key of Object.keys(changes)) {
      ctx.recordDiff({
        entity: "taxSettings",
        entityId: String(siteId),
        path: key,
        before: (current as Record<string, unknown> | undefined)?.[key] ?? null,
        after: (row as unknown as Record<string, unknown>)[key],
      });
    }
    return row;
  },
});
