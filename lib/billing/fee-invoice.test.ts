import { describe, expect, it } from "vitest";
import { assessmentBillable, feeLineDescription, type BillableAssessment } from "./fee-invoice";

/**
 * The gate between a measurement and a charge (§17, `docs/PRICING.md` §4).
 *
 * `assessmentBillable` is the last thing standing between a closed assessment
 * and a merchant's card, so every refusal it makes is tested individually.
 * These are exactly the conditions no type can express and no integration test
 * would reach without deliberately constructing a broken org.
 */

const base: BillableAssessment = {
  id: "fa_1",
  periodStart: new Date("2026-07-01T00:00:00Z"),
  periodEnd: new Date("2026-08-01T00:00:00Z"),
  planId: "growth",
  productClass: "physical",
  currency: "USD",
  feeMinor: 12_50,
  billableMinor: 2_500_00,
  thresholdMinor: 50_000_00,
  overageRateBps: 50,
  invoiced: false,
};

const ok = { customerId: "cus_1", subscriptionActive: true, billingCurrency: "USD" };

describe("assessmentBillable", () => {
  it("allows a closed, unbilled, non-zero assessment on an active subscription", () => {
    expect(assessmentBillable(base, ok)).toEqual({ ok: true });
  });

  /** A closed period bills once. Retrying must not raise a second charge. */
  it("refuses one already invoiced", () => {
    const r = assessmentBillable({ ...base, invoiced: true }, ok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/already invoiced/i);
  });

  /**
   * A merchant under their threshold owes nothing. A zero line on an invoice
   * only invites the question of what it is for.
   */
  it("refuses a zero or negative fee", () => {
    for (const feeMinor of [0, -1]) {
      const r = assessmentBillable({ ...base, feeMinor }, ok);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/nothing is owed/i);
    }
  });

  it("refuses when there is no Stripe customer to bill", () => {
    const r = assessmentBillable(base, { ...ok, customerId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("refused");
  });

  /**
   * **The trap the module is shaped around.** A pending invoice item with no
   * subscription invoice to ride on is never billed, never expires, and later
   * attaches to whatever invoice eventually appears — charging a merchant for a
   * period they have long since forgotten.
   */
  it("refuses when no subscription exists for the item to ride on", () => {
    const r = assessmentBillable(base, { ...ok, subscriptionActive: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/never be billed/i);
  });

  /**
   * No FX provider is wired, so converting here would invent a rate — the same
   * refusal the meter makes for unconverted usage records rather than summing
   * them as zero.
   */
  it("refuses a currency the customer does not bill in", () => {
    const r = assessmentBillable({ ...base, currency: "EUR" }, ok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/EUR.*USD|cannot combine/i);
  });

  it("compares currency case-insensitively rather than refusing on formatting", () => {
    expect(assessmentBillable({ ...base, currency: "usd" }, ok)).toEqual({ ok: true });
  });
});

describe("feeLineDescription", () => {
  /** Whatever the merchant reads must let them re-derive the number themselves. */
  const format = (minor: number) => `$${(minor / 100).toFixed(2)}`;

  it("names the period, the class, the threshold, and the rate", () => {
    const line = feeLineDescription(base, format);
    expect(line).toContain("2026-07-01");
    expect(line).toContain("2026-08-01");
    expect(line).toContain("physical");
    // 50_000_00 minor units is $50,000.00 — the Growth threshold, not $500.
    expect(line).toContain("$50000.00");
    expect(line).toContain("$2500.00"); // the billable slice above it
    expect(line).toContain("0.50%"); // 50 bps, not "50%"
  });

  /**
   * Basis points are not percent. Rendering 50 bps as "50%" would put a
   * hundredfold error on an invoice a merchant is meant to check.
   */
  it("renders basis points as a percentage, not as a raw number", () => {
    expect(feeLineDescription({ ...base, overageRateBps: 150 }, format)).toContain("1.50%");
    expect(feeLineDescription({ ...base, overageRateBps: 25 }, format)).toContain("0.25%");
  });

  /** Assessments closed before the D39 split carry no class and must not claim one. */
  it("says only 'sales' when the class is unknown", () => {
    const line = feeLineDescription({ ...base, productClass: null }, format);
    expect(line).toContain("sales");
    expect(line).not.toContain("physical");
    expect(line).not.toContain("digital");
  });
});
