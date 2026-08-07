import { describe, expect, it } from "vitest";
import { splitNetSales, type ProductClass } from "./product-class";

/**
 * The split decides which of two thresholds a merchant's money counts against
 * (D39), so the property that matters is not any single figure — it is that the
 * parts always add back to the whole. Money that falls between the two meters is
 * money the merchant is never billed for; money counted twice is a merchant
 * billed twice.
 */
describe("splitNetSales", () => {
  const classOf = new Map<number, ProductClass>([
    [1, "physical"],
    [2, "digital"],
  ]);

  it("meters net sales, not the line total", () => {
    // subtotal − discount (docs/PRICING.md §4.1). Tax and shipping never appear
    // in a line's contribution because they are not revenue.
    const split = splitNetSales(
      [{ productId: 1, subtotalMinor: 10_000, discountMinor: 1_500 }],
      classOf,
    );
    expect(split.physical).toBe(8_500);
    expect(split.digital).toBe(0);
  });

  it("separates a mixed basket", () => {
    const split = splitNetSales(
      [
        { productId: 1, subtotalMinor: 10_000, discountMinor: 0 },
        { productId: 2, subtotalMinor: 4_000, discountMinor: 500 },
        { productId: 1, subtotalMinor: 2_000, discountMinor: 200 },
      ],
      classOf,
    );
    expect(split.physical).toBe(11_800);
    expect(split.digital).toBe(3_500);
  });

  it("always sums back to the order's own net sales", () => {
    const lines = [
      { productId: 1, subtotalMinor: 3_333, discountMinor: 111 },
      { productId: 2, subtotalMinor: 6_667, discountMinor: 222 },
      { productId: 2, subtotalMinor: 1, discountMinor: 1 },
    ];
    const split = splitNetSales(lines, classOf);
    const expected = lines.reduce((n, l) => n + l.subtotalMinor - l.discountMinor, 0);
    expect(split.physical + split.digital).toBe(expected);
  });

  it("treats an unknown or missing product as physical", () => {
    // The cheaper rate on every plan — an uncertain guess must not cost the
    // merchant money, and a deleted catalog row is exactly that.
    const split = splitNetSales(
      [
        { productId: null, subtotalMinor: 5_000, discountMinor: 0 },
        { productId: 999, subtotalMinor: 1_000, discountMinor: 0 },
      ],
      classOf,
    );
    expect(split).toEqual({ physical: 6_000, digital: 0 });
  });

  it("handles an empty basket without inventing a class", () => {
    expect(splitNetSales([], classOf)).toEqual({ physical: 0, digital: 0 });
  });

  it("carries a fully discounted line as zero rather than dropping it", () => {
    const split = splitNetSales(
      [{ productId: 2, subtotalMinor: 2_000, discountMinor: 2_000 }],
      classOf,
    );
    expect(split.digital).toBe(0);
  });
});
