import { describe, expect, it } from "vitest";
import { priceOf, rateApplies, weightOf, zoneFor } from "./shipping";
import type { CartAddress, ShippingRate, ShippingZone } from "../db";

/** Shipping zone and rate rules (§18.6) — pure, no database. */

const zone = (over: Partial<ShippingZone> & { id: number; name: string }): ShippingZone => ({
  siteId: 1,
  countries: [],
  provinces: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const rate = (over: Partial<ShippingRate> & { type: ShippingRate["type"] }): ShippingRate => ({
  id: 1,
  zoneId: 1,
  name: "Rate",
  description: null,
  priceMinor: 500,
  minWeightGrams: null,
  maxWeightGrams: null,
  minSubtotalMinor: null,
  maxSubtotalMinor: null,
  enabled: true,
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const addr = (country: string, province?: string): CartAddress => ({
  line1: "1 Test St",
  city: "Testville",
  country,
  province: province ?? null,
});

describe("zoneFor", () => {
  const us = zone({ id: 1, name: "United States", countries: ["US"] });
  const co = zone({ id: 2, name: "Colorado", countries: ["US"], provinces: ["CO"] });
  const rest = zone({ id: 3, name: "Rest of world" });

  it("prefers the provincial zone over the country zone", () => {
    expect(zoneFor([us, co, rest], addr("US", "CO"))?.name).toBe("Colorado");
  });

  it("does not depend on the order zones are given in", () => {
    expect(zoneFor([co, us, rest], addr("US", "CO"))?.name).toBe("Colorado");
    expect(zoneFor([rest, us, co], addr("US", "CO"))?.name).toBe("Colorado");
  });

  it("falls back to the country zone for another province", () => {
    expect(zoneFor([us, co, rest], addr("US", "TX"))?.name).toBe("United States");
  });

  it("uses the catch-all for an unlisted country", () => {
    expect(zoneFor([us, co, rest], addr("JP"))?.name).toBe("Rest of world");
  });

  it("matches case-insensitively", () => {
    expect(zoneFor([us, co], addr("us", "co"))?.name).toBe("Colorado");
  });

  it("returns null when nothing matches and there is no catch-all", () => {
    expect(zoneFor([us, co], addr("JP"))).toBeNull();
  });

  it("returns null without a country", () => {
    expect(zoneFor([us, rest], { ...addr("US"), country: "" })).toBeNull();
  });
});

describe("rateApplies", () => {
  it("treats weight bounds as inclusive at both ends", () => {
    const r = rate({ type: "weight_based", minWeightGrams: 1000, maxWeightGrams: 5000 });
    // A merchant writing "1000-5000g" means a 1000g parcel qualifies.
    expect(rateApplies(r, { subtotalMinor: 0, weightGrams: 1000 })).toBe(true);
    expect(rateApplies(r, { subtotalMinor: 0, weightGrams: 5000 })).toBe(true);
    expect(rateApplies(r, { subtotalMinor: 0, weightGrams: 999 })).toBe(false);
    expect(rateApplies(r, { subtotalMinor: 0, weightGrams: 5001 })).toBe(false);
  });

  it("treats subtotal bounds as inclusive at both ends", () => {
    const r = rate({ type: "price_based", minSubtotalMinor: 2000, maxSubtotalMinor: 8000 });
    expect(rateApplies(r, { subtotalMinor: 2000, weightGrams: 0 })).toBe(true);
    expect(rateApplies(r, { subtotalMinor: 8000, weightGrams: 0 })).toBe(true);
    expect(rateApplies(r, { subtotalMinor: 1999, weightGrams: 0 })).toBe(false);
    expect(rateApplies(r, { subtotalMinor: 8001, weightGrams: 0 })).toBe(false);
  });

  it("applies an unbounded flat rate to anything", () => {
    const r = rate({ type: "flat" });
    expect(rateApplies(r, { subtotalMinor: 0, weightGrams: 0 })).toBe(true);
    expect(rateApplies(r, { subtotalMinor: 999999, weightGrams: 999999 })).toBe(true);
  });

  it("never applies a disabled rate", () => {
    expect(rateApplies(rate({ type: "flat", enabled: false }), { subtotalMinor: 0, weightGrams: 0 }))
      .toBe(false);
  });

  it("withholds a free-shipping rate below its threshold", () => {
    // The regression behind D35: minSubtotalMinor is an eligibility bound for
    // every type, including this one.
    const r = rate({ type: "free_over_threshold", priceMinor: 0, minSubtotalMinor: 5000 });
    expect(rateApplies(r, { subtotalMinor: 4999, weightGrams: 0 })).toBe(false);
    expect(rateApplies(r, { subtotalMinor: 5000, weightGrams: 0 })).toBe(true);
  });
});

describe("priceOf", () => {
  it("charges a flat rate its price", () => {
    expect(priceOf(rate({ type: "flat", priceMinor: 599 }))).toBe(599);
  });

  it("is always free for free_over_threshold, since it is only offered above it", () => {
    // D35: the earlier version charged priceMinor below the threshold *and*
    // withheld the rate, so "Free over $50" was wrong in both directions.
    expect(priceOf(rate({ type: "free_over_threshold", priceMinor: 0, minSubtotalMinor: 5000 })))
      .toBe(0);
  });
});

describe("weightOf", () => {
  it("multiplies by quantity and ignores non-shippable lines", () => {
    expect(
      weightOf([
        { quantity: 3, weightGrams: 500, requiresShipping: true },
        { quantity: 2, weightGrams: 250, requiresShipping: true },
        { quantity: 9, weightGrams: 9999, requiresShipping: false },
      ]),
    ).toBe(2000);
  });

  it("treats an unrecorded weight as zero rather than failing", () => {
    expect(weightOf([{ quantity: 2, weightGrams: null, requiresShipping: true }])).toBe(0);
  });

  it("is zero for an empty cart", () => {
    expect(weightOf([])).toBe(0);
  });
});
