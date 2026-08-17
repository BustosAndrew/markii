import { describe, expect, it } from "vitest";
import { normalizeBreakdown, type BreakdownRow } from "./stripe-tax";

/**
 * Turning Stripe's tax breakdown into a receipt line (§18.6).
 *
 * This is the part of the Stripe Tax path that can be checked without a Stripe
 * account, and it is also the part a shopper reads. A rate that comes back
 * wrong here is printed on a receipt and copied into the order record — so the
 * conversion from Stripe's decimal percentage to integer basis points, and the
 * naming, are pinned rather than assumed.
 */

const row = (over: Partial<BreakdownRow> = {}): BreakdownRow => ({
  amount: 875,
  inclusive: false,
  tax_rate_details: { percentage_decimal: "8.75", tax_type: "sales_tax", state: "CO" },
  ...over,
});

describe("normalizeBreakdown", () => {
  it("converts Stripe's decimal percentage to integer basis points", () => {
    expect(normalizeBreakdown([row()])[0].rateBps).toBe(875);
    expect(
      normalizeBreakdown([
        row({ tax_rate_details: { percentage_decimal: "20", tax_type: "vat", country: "GB" } }),
      ])[0].rateBps,
    ).toBe(2000);
  });

  it("rounds a sub-basis-point rate rather than truncating it", () => {
    // 7.375% is 737.5 bps. Truncating would under-state the rate on the receipt
    // against an amount Stripe already computed at the full precision.
    expect(
      normalizeBreakdown([row({ tax_rate_details: { percentage_decimal: "7.375" } })])[0].rateBps,
    ).toBe(738);
  });

  it("never yields NaN when Stripe sends no percentage", () => {
    const [only] = normalizeBreakdown([row({ tax_rate_details: {} })]);
    expect(only.rateBps).toBe(0);
    // The **amount** is Stripe's and survives a missing rate: a receipt showing
    // the money with no rate is honest; one showing NaN is broken.
    expect(only.amountMinor).toBe(875);
  });

  it("names a jurisdiction a shopper can read", () => {
    expect(normalizeBreakdown([row()])[0].name).toBe("CO Sales tax");
    expect(
      normalizeBreakdown([
        row({ jurisdiction: { display_name: "California" }, tax_rate_details: { tax_type: "sales_tax" } }),
      ])[0].name,
    ).toBe("California Sales tax");
    expect(
      normalizeBreakdown([
        row({ tax_rate_details: { tax_type: "vat", country: "GB" } }),
      ])[0].name,
    ).toBe("GB VAT");
  });

  it("falls back to a plain name rather than inventing a jurisdiction", () => {
    expect(normalizeBreakdown([row({ tax_rate_details: {} })])[0].name).toBe("Tax");
  });

  it("passes an unknown tax type through instead of dropping it", () => {
    // Stripe adds tax types; an unmapped one must still reach the receipt.
    expect(
      normalizeBreakdown([
        row({ tax_rate_details: { tax_type: "some_new_levy", state: "NY" } }),
      ])[0].name,
    ).toBe("NY some_new_levy");
  });

  it("drops the zero-amount rows Stripe returns for jurisdictions it cleared", () => {
    const rows = [row(), row({ amount: 0, tax_rate_details: { percentage_decimal: "0" } })];
    expect(normalizeBreakdown(rows)).toHaveLength(1);
  });

  it("keeps a negative row, which is a reversal and not noise", () => {
    expect(normalizeBreakdown([row({ amount: -875 })])).toHaveLength(1);
  });

  it("preserves Stripe's amounts unscaled", () => {
    // Minor units both sides. A `/100` here would misreport a JPY store by 100× (D31).
    expect(normalizeBreakdown([row({ amount: 1234567 })])[0].amountMinor).toBe(1234567);
  });
});
