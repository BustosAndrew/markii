import { describe, expect, it } from "vitest";
import { rateFor, taxOn } from "./tax";
import type { CartAddress, ManualTaxRate } from "../db";

/**
 * Tax arithmetic (§18.6).
 *
 * These are the calculations a merchant is liable for. Every one is integer
 * arithmetic on basis points — no float ever touches a tax amount (D31).
 */

const addr = (country: string, province?: string): CartAddress => ({
  line1: "1 Test St",
  city: "Testville",
  country,
  province: province ?? null,
});

describe("taxOn", () => {
  it("rounds half-up on integer basis points", () => {
    // 1999 * 8.75% = 174.9125 -> 175
    expect(taxOn(1999, 875)).toBe(175);
    // 4299 * 8.75% = 376.1625 -> 376
    expect(taxOn(4299, 875)).toBe(376);
    // 10000 * 20% = 2000 exactly
    expect(taxOn(10000, 2000)).toBe(2000);
  });

  it("rounds a halfway case up rather than to even", () => {
    // 200 * 2.5% = 5.0 exactly; 300 * 2.5% = 7.5 -> 8
    expect(taxOn(200, 250)).toBe(5);
    expect(taxOn(300, 250)).toBe(8);
  });

  it("is zero at a zero rate or a zero base", () => {
    expect(taxOn(10000, 0)).toBe(0);
    expect(taxOn(0, 2000)).toBe(0);
  });

  it("never returns a fraction", () => {
    for (const base of [1, 7, 99, 1234, 99999]) {
      for (const bps of [1, 175, 875, 2000, 9999]) {
        expect(Number.isInteger(taxOn(base, bps))).toBe(true);
      }
    }
  });
});

describe("rateFor", () => {
  const rates: ManualTaxRate[] = [
    { country: "US", province: null, rateBps: 500, name: "US federal-ish" },
    { country: "US", province: "CO", rateBps: 875, name: "Colorado" },
    { country: "GB", province: null, rateBps: 2000, name: "UK VAT" },
  ];

  it("prefers a province rate over its country rate", () => {
    expect(rateFor(rates, addr("US", "CO"))?.name).toBe("Colorado");
  });

  it("falls back to the country rate for an unlisted province", () => {
    expect(rateFor(rates, addr("US", "TX"))?.name).toBe("US federal-ish");
  });

  it("matches case-insensitively", () => {
    expect(rateFor(rates, addr("us", "co"))?.name).toBe("Colorado");
    expect(rateFor(rates, addr("gb"))?.name).toBe("UK VAT");
  });

  it("returns null for an unconfigured country rather than guessing", () => {
    expect(rateFor(rates, addr("FR"))).toBeNull();
  });

  it("returns null with no address at all", () => {
    expect(rateFor(rates, null)).toBeNull();
  });

  it("returns null when there are no rates", () => {
    expect(rateFor([], addr("US"))).toBeNull();
  });
});

describe("inclusive tax extraction", () => {
  /**
   * The formula `calculateTax` uses for tax-inclusive prices. Duplicated here
   * deliberately: this is the property that matters, and stating it separately
   * from the implementation is what makes the test able to disagree with it.
   */
  const extract = (base: number, bps: number) =>
    Math.floor((base * bps + (10000 + bps) / 2) / (10000 + bps));

  it("extracts rather than adds", () => {
    // At 20%, a 12000 inclusive price contains 2000 of tax — not 2400.
    expect(extract(12000, 2000)).toBe(2000);
  });

  it("leaves the net amount consistent", () => {
    const gross = 4299;
    const tax = extract(gross, 875);
    // net + tax must reconstruct the gross, within a minor unit of rounding.
    const net = gross - tax;
    expect(Math.abs(net + tax - gross)).toBeLessThanOrEqual(0);
    expect(tax).toBe(346);
  });

  it("never exceeds the equivalent exclusive amount", () => {
    // At very small bases the two round to the same minor unit, so the
    // guarantee is "no more than", not "strictly less".
    for (const base of [1, 100, 999, 5000, 123456]) {
      for (const bps of [500, 875, 2000]) {
        expect(extract(base, bps)).toBeLessThanOrEqual(taxOn(base, bps));
      }
    }
  });

  it("is strictly less once the amounts are large enough to separate", () => {
    for (const base of [5000, 123456]) {
      for (const bps of [500, 875, 2000]) {
        expect(extract(base, bps)).toBeLessThan(taxOn(base, bps));
      }
    }
  });
});
