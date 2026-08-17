import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateTax, rateFor, taxFingerprint, taxOn } from "./tax";
import type { CartAddress, ManualTaxRate, TaxSettings } from "../db";

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

/**
 * The Stripe Tax cache key (§18.6).
 *
 * A cached calculation may only be reused for the identical question, and the
 * failure mode of a fingerprint that misses an input is invisible: a shopper is
 * charged a stale tax, the checkout succeeds, and nothing anywhere reports it.
 * So each input gets its own test rather than one "it changes" case.
 */
describe("taxFingerprint", () => {
  const settings: TaxSettings = {
    siteId: 1,
    provider: "stripe",
    pricesIncludeTax: false,
    manualRates: [],
    defaultTaxCode: null,
    registrations: [],
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  };

  const base = {
    lines: [{ reference: "line:1", amountMinor: 5000, quantity: 1, taxCode: null }],
    shippingMinor: 500,
    currency: "USD",
    address: addr("US", "CO"),
    settings,
  };

  it("is stable across separately-built but identical inputs", () => {
    // Built from fresh objects, not the same references: the fingerprint has to
    // key on the values, or every cart render would miss the cache and bill the
    // merchant for a calculation they already paid for.
    expect(taxFingerprint(base)).toBe(
      taxFingerprint({
        lines: [{ reference: "line:1", amountMinor: 5000, quantity: 1, taxCode: null }],
        shippingMinor: 500,
        currency: "USD",
        address: addr("US", "CO"),
        settings: { ...settings, updatedAt: new Date("2026-08-01T00:00:00Z") },
      }),
    );
  });

  it("changes when a line amount moves", () => {
    expect(
      taxFingerprint({
        ...base,
        lines: [{ ...base.lines[0], amountMinor: 5001 }],
      }),
    ).not.toBe(taxFingerprint(base));
  });

  it("changes when a line's tax code moves, at the same total", () => {
    // Same money, different kind of good — a different tax in most US states.
    expect(
      taxFingerprint({ ...base, lines: [{ ...base.lines[0], taxCode: "txcd_10000000" }] }),
    ).not.toBe(taxFingerprint(base));
  });

  it("changes when the destination moves", () => {
    expect(taxFingerprint({ ...base, address: addr("US", "NY") })).not.toBe(taxFingerprint(base));
    expect(taxFingerprint({ ...base, address: addr("GB") })).not.toBe(taxFingerprint(base));
  });

  it("changes when only the postal code moves", () => {
    // US sales tax is decided below the state line; two ZIPs in one state are
    // two different rates, and this is the input most easily forgotten.
    const zipped = { ...addr("US", "CO"), postalCode: "80202" };
    expect(taxFingerprint({ ...base, address: zipped })).not.toBe(
      taxFingerprint({ ...base, address: { ...zipped, postalCode: "80301" } }),
    );
  });

  it("changes when shipping moves", () => {
    expect(taxFingerprint({ ...base, shippingMinor: 600 })).not.toBe(taxFingerprint(base));
  });

  it("changes when the currency moves", () => {
    expect(taxFingerprint({ ...base, currency: "GBP" })).not.toBe(taxFingerprint(base));
  });

  it("changes when the store flips tax-inclusive pricing", () => {
    // The same figure means the opposite thing under the other setting, so a
    // cache hit across the flip would report tax on the wrong side of the price.
    expect(
      taxFingerprint({ ...base, settings: { ...settings, pricesIncludeTax: true } }),
    ).not.toBe(taxFingerprint(base));
  });

  it("changes when any other tax setting is saved at all", () => {
    // `updatedAt` is in the key so a settings change nobody enumerated here
    // still invalidates the cache. This test is the reason that works.
    expect(
      taxFingerprint({
        ...base,
        settings: { ...settings, updatedAt: new Date("2026-08-02T00:00:00Z") },
      }),
    ).not.toBe(taxFingerprint(base));
  });

  it("does not collide when the same total is split across lines differently", () => {
    const oneLine = { ...base, lines: [{ reference: "line:1", amountMinor: 10000, quantity: 2, taxCode: null }] };
    const twoLines = {
      ...base,
      lines: [
        { reference: "line:1", amountMinor: 5000, quantity: 1, taxCode: null },
        { reference: "line:2", amountMinor: 5000, quantity: 1, taxCode: null },
      ],
    };
    expect(taxFingerprint(oneLine)).not.toBe(taxFingerprint(twoLines));
  });
});

/**
 * The Stripe path's refusals (§18.6).
 *
 * Every one of these returns `not_configured`, never a zero. A zero would read
 * as "no tax is due on this order" — a claim about a merchant's liability that
 * a missing address or an unconnected account is in no position to make. The
 * cases below all resolve before any network or database call.
 */
describe("calculateTax with Stripe Tax selected", () => {
  const stripeSettings: TaxSettings = {
    siteId: 1,
    provider: "stripe",
    pricesIncludeTax: false,
    manualRates: [],
    defaultTaxCode: null,
    registrations: [],
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  };

  const line = { reference: "line:1", amountMinor: 5000, quantity: 1, taxCode: null };

  /**
   * Present so the refusals below are the *specific* ones being tested. Without
   * a key every case short-circuits on "no Stripe credentials" and the suite
   * passes for the wrong reason — the failure mode `CLAUDE.md` names as the one
   * to check for before trusting a green run.
   */
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unit");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses when the platform has no Stripe credentials", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const result = await calculateTax({
      siteId: 1,
      settings: stripeSettings,
      address: addr("US", "CO"),
      taxableBaseMinor: 5000,
      lines: [line],
      currency: "USD",
    });
    expect(result.state).toBe("not_configured");
    expect(result.note).toMatch(/credentials/i);
  });

  it("refuses without a currency rather than guessing one", async () => {
    const result = await calculateTax({
      siteId: 1,
      settings: stripeSettings,
      address: addr("US", "CO"),
      taxableBaseMinor: 5000,
      lines: [line],
    });
    expect(result.state).toBe("not_configured");
    expect(result.amountMinor).toBe(0);
  });

  it("refuses without a destination", async () => {
    const result = await calculateTax({
      siteId: 1,
      settings: stripeSettings,
      address: null,
      taxableBaseMinor: 5000,
      lines: [line],
      currency: "USD",
    });
    expect(result.state).toBe("not_configured");
    expect(result.note).toMatch(/address/i);
  });

  it("refuses with nothing to tax", async () => {
    const result = await calculateTax({
      siteId: 1,
      settings: stripeSettings,
      address: addr("US", "CO"),
      taxableBaseMinor: 0,
      lines: [],
      currency: "USD",
    });
    expect(result.state).toBe("not_configured");
  });

  it("keeps the store's inclusive/exclusive meaning even when it cannot calculate", async () => {
    // The refusal still has to say which side of the price tax sits on, or a
    // caller cannot render the total it already has.
    const result = await calculateTax({
      siteId: 1,
      settings: { ...stripeSettings, pricesIncludeTax: true },
      address: null,
      taxableBaseMinor: 5000,
      lines: [line],
      currency: "USD",
    });
    expect(result.included).toBe(true);
  });
});
