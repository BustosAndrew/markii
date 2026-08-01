import { asc, eq, inArray } from "drizzle-orm";
import {
  cartLines,
  db,
  shippingRates,
  shippingZones,
  variants,
  type CartAddress,
  type ShippingRate,
  type ShippingZone,
} from "../db";

/**
 * Shipping rate quoting (§18.6).
 *
 * **Configuration, not logistics.** Carrier rate shopping, label purchase, and
 * tracking sync are permanently out of scope (`docs/PLAN.md` §3). What this does
 * is evaluate the merchant's own rate table against a destination and a cart.
 *
 * Everything here is pure arithmetic over stored bounds. There is no rule
 * interpreter, no expression language, and no external call — a shipping quote
 * that could fail or time out would take the checkout down with it.
 */

export type QuotedRate = {
  id: string;
  zoneId: number;
  zoneName: string;
  name: string;
  description: string | null;
  type: ShippingRate["type"];
  priceMinor: number;
};

/**
 * Picks the zone serving an address.
 *
 * **Most specific wins.** A zone naming provinces beats one naming only the
 * country, which beats a catch-all — otherwise a "California" rate and a
 * "United States" rate would both match and the winner would depend on row
 * order, which is how a merchant's careful regional pricing silently stops
 * applying.
 */
export function zoneFor(zones: ShippingZone[], address: CartAddress): ShippingZone | null {
  const country = address.country?.toUpperCase();
  const province = address.province?.toUpperCase() ?? null;
  if (!country) return null;

  const byCountry = zones.filter((z) => z.countries.map((c) => c.toUpperCase()).includes(country));

  if (province) {
    const provincial = byCountry.find((z) =>
      z.provinces.length > 0 && z.provinces.map((p) => p.toUpperCase()).includes(province),
    );
    if (provincial) return provincial;
  }

  const countryWide = byCountry.find((z) => z.provinces.length === 0);
  if (countryWide) return countryWide;

  // A zone with no countries at all is the merchant's "rest of world" fallback.
  return zones.find((z) => z.countries.length === 0) ?? null;
}

/** Total shippable weight. Items with no weight recorded contribute nothing. */
export function weightOf(
  lines: { quantity: number; weightGrams: number | null; requiresShipping: boolean }[],
): number {
  return lines
    .filter((l) => l.requiresShipping)
    .reduce((sum, l) => sum + (l.weightGrams ?? 0) * l.quantity, 0);
}

/**
 * Whether a rate applies to this cart.
 *
 * Bounds are inclusive-lower, inclusive-upper. Inclusive-upper matters more than
 * it looks: a merchant writing "0–1000g £3, 1000–5000g £6" means a 1000g parcel
 * costs £3, and an exclusive upper bound would quietly charge them £6.
 */
export function rateApplies(
  rate: ShippingRate,
  ctx: { subtotalMinor: number; weightGrams: number },
): boolean {
  if (!rate.enabled) return false;

  if (rate.minWeightGrams != null && ctx.weightGrams < rate.minWeightGrams) return false;
  if (rate.maxWeightGrams != null && ctx.weightGrams > rate.maxWeightGrams) return false;
  if (rate.minSubtotalMinor != null && ctx.subtotalMinor < rate.minSubtotalMinor) return false;
  if (rate.maxSubtotalMinor != null && ctx.subtotalMinor > rate.maxSubtotalMinor) return false;

  return true;
}

/**
 * What a rate costs.
 *
 * `free_over_threshold` is always zero, because it is only ever *offered* once
 * its threshold is met — `minSubtotalMinor` is an eligibility bound like any
 * other, evaluated by {@link rateApplies}. The first version of this overloaded
 * that field to mean two different things depending on type (a bound for
 * `price_based`, a free-at line for `free_over_threshold`), and a rate named
 * "Free over $50" then quietly failed to appear at $40 *and* charged money at
 * $60. One field, one meaning.
 *
 * `priceMinor` is therefore ignored for this type, and the action layer forces
 * it to zero so no merchant ever sets a number that does nothing.
 */
export function priceOf(rate: ShippingRate): number {
  return rate.type === "free_over_threshold" ? 0 : rate.priceMinor;
}

/** Line weights and shipping requirements for a cart, from the variants. */
export async function shippableLines(cartId: number) {
  const rows = await db
    .select({ quantity: cartLines.quantity, variantId: cartLines.variantId })
    .from(cartLines)
    .where(eq(cartLines.cartId, cartId));

  const ids = rows.map((r) => r.variantId).filter((v): v is number => v != null);
  const vars = ids.length
    ? await db
        .select({
          id: variants.id,
          weightGrams: variants.weightGrams,
          requiresShipping: variants.requiresShipping,
        })
        .from(variants)
        .where(inArray(variants.id, ids))
    : [];
  const byId = new Map(vars.map((v) => [v.id, v]));

  return rows.map((r) => {
    const v = r.variantId != null ? byId.get(r.variantId) : undefined;
    return {
      quantity: r.quantity,
      weightGrams: v?.weightGrams ?? null,
      // A product with no variant has no shipping attributes at all and has been
      // sold without a shipping charge since v1 (D33). Same rule as pricing.
      requiresShipping: v?.requiresShipping ?? false,
    };
  });
}

export type ShippingQuote =
  | { state: "not_required"; rates: [] }
  | { state: "no_zone"; rates: []; reason: string }
  | { state: "no_address"; rates: []; reason: string }
  | { state: "not_configured"; rates: []; reason: string }
  | { state: "quoted"; rates: QuotedRate[]; zone: { id: number; name: string } };

/**
 * Quotes every rate a shopper may choose for this cart and destination.
 *
 * Each unquotable case is a **distinct state with its own reason**, because
 * "there are no rates" is the one answer that must never be collapsed into
 * "shipping is free". A store with no zones, a destination the merchant does not
 * ship to, and a cart of digital goods are three different situations and the
 * shopper is owed the difference.
 */
export async function quoteShipping(input: {
  siteId: number;
  cartId: number;
  address: CartAddress | null;
  subtotalMinor: number;
}): Promise<ShippingQuote> {
  const lines = await shippableLines(input.cartId);
  if (!lines.some((l) => l.requiresShipping)) return { state: "not_required", rates: [] };

  const zones = await db
    .select()
    .from(shippingZones)
    .where(eq(shippingZones.siteId, input.siteId));
  if (zones.length === 0) {
    return {
      state: "not_configured",
      rates: [],
      reason:
        "This store has not configured any shipping zones yet (docs/API.md §18.6). " +
        "No rate is quoted because none exists — this is not a free-shipping offer.",
    };
  }

  if (!input.address?.country) {
    return {
      state: "no_address",
      rates: [],
      reason: "A shipping address is required before rates can be quoted.",
    };
  }

  const zone = zoneFor(zones, input.address);
  if (!zone) {
    return {
      state: "no_zone",
      rates: [],
      reason: `This store does not ship to ${input.address.country}.`,
    };
  }

  const weightGrams = weightOf(lines);
  const all = await db
    .select()
    .from(shippingRates)
    .where(eq(shippingRates.zoneId, zone.id))
    .orderBy(asc(shippingRates.position), asc(shippingRates.id));

  const applicable = all.filter((r) => rateApplies(r, { subtotalMinor: input.subtotalMinor, weightGrams }));
  if (applicable.length === 0) {
    return {
      state: "no_zone",
      rates: [],
      reason:
        `No rate in "${zone.name}" applies to this cart ` +
        `(${weightGrams}g, subtotal ${input.subtotalMinor}). The merchant has not set one up.`,
    };
  }

  return {
    state: "quoted",
    zone: { id: zone.id, name: zone.name },
    rates: applicable.map((r) => ({
      // Stable across quotes so a cart's stored `shippingRateId` keeps meaning
      // the same thing between the rate list and checkout.
      id: String(r.id),
      zoneId: zone.id,
      zoneName: zone.name,
      name: r.name,
      description: r.description,
      type: r.type,
      priceMinor: priceOf(r),
    })),
  };
}

/**
 * Re-prices the rate a cart has selected.
 *
 * Never trusts the stored price — the rate is looked up and recomputed, so a
 * merchant lowering a rate between selection and checkout charges the new price
 * and a selection that stopped applying (the cart shrank below a free-shipping
 * threshold) fails rather than quietly staying free.
 */
export async function selectedRate(input: {
  siteId: number;
  cartId: number;
  address: CartAddress | null;
  subtotalMinor: number;
  shippingRateId: string | null;
}): Promise<{ rate: QuotedRate | null; quote: ShippingQuote }> {
  const quote = await quoteShipping(input);
  if (quote.state !== "quoted" || !input.shippingRateId) return { rate: null, quote };
  return {
    rate: quote.rates.find((r) => r.id === input.shippingRateId) ?? null,
    quote,
  };
}
