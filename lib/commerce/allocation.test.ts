import { describe, expect, it } from "vitest";
import { allocate, shareOfUnits } from "./allocation";

/**
 * Allocation (§18.7) — pure, no database.
 *
 * The property under test throughout is **conservation**: an allocation that
 * loses or invents a minor unit is a refund that returns the wrong money.
 */

describe("allocate", () => {
  it("splits in proportion when the division is exact", () => {
    expect(allocate(300, [1000, 2000])).toEqual([100, 200]);
  });

  it("loses nothing to rounding", () => {
    const shares = allocate(100, [333, 333, 334]);
    expect(shares.reduce((s, n) => s + n, 0)).toBe(100);
  });

  it("gives the remainder to the largest fractional share, not the first line", () => {
    // Exact thirds of 10 are 3.33 each: two lines get 3, one gets 4.
    const shares = allocate(10, [100, 100, 100]);
    expect(shares.reduce((s, n) => s + n, 0)).toBe(10);
    expect(shares.filter((n) => n === 4)).toHaveLength(1);
  });

  it("is deterministic — the same inputs always split the same way", () => {
    const a = allocate(97, [17, 41, 41, 3]);
    const b = allocate(97, [17, 41, 41, 3]);
    expect(a).toEqual(b);
  });

  it("conserves the total across a wide range of awkward splits", () => {
    for (let amount = 0; amount <= 200; amount++) {
      for (const weights of [[1, 2, 3], [7, 7, 7], [1, 0, 99], [5], [1, 1, 1, 1, 1, 1, 1]]) {
        expect(allocate(amount, weights).reduce((s, n) => s + n, 0)).toBe(amount);
      }
    }
  });

  it("never allocates to a zero weight when other lines carry the total", () => {
    expect(allocate(100, [0, 100])).toEqual([0, 100]);
  });

  it("spreads evenly rather than dropping money when every weight is zero", () => {
    // A fully discounted order still has to account for tax on shipping. Zeroing
    // it here would leave an order whose lines do not sum to its own totals.
    const shares = allocate(7, [0, 0, 0]);
    expect(shares.reduce((s, n) => s + n, 0)).toBe(7);
    expect(shares).toEqual([3, 2, 2]);
  });

  it("returns zeros for a zero amount", () => {
    expect(allocate(0, [10, 20])).toEqual([0, 0]);
  });

  it("refuses a negative amount rather than inventing a sign convention", () => {
    expect(() => allocate(-1, [10])).toThrow();
  });

  it("refuses to split a non-zero amount across no lines", () => {
    expect(() => allocate(5, [])).toThrow();
    expect(allocate(0, [])).toEqual([]);
  });
});

describe("shareOfUnits", () => {
  it("returns the whole amount when every unit is taken at once", () => {
    expect(shareOfUnits(1000, 0, 3, 3)).toBe(1000);
  });

  it("returns nothing for a line with no quantity", () => {
    expect(shareOfUnits(1000, 0, 1, 0)).toBe(0);
  });

  it("returns exactly the line total when refunded in pieces", () => {
    // 10 across 3 units: naive independent rounding pays 3+3+3=9 and strands a
    // penny. The cumulative form gives the last refund the residue.
    const first = shareOfUnits(10, 0, 1, 3);
    const second = shareOfUnits(10, 1, 1, 3);
    const third = shareOfUnits(10, 2, 1, 3);
    expect(first + second + third).toBe(10);
  });

  it("conserves the line total for every split of every awkward amount", () => {
    for (let amount = 0; amount <= 100; amount++) {
      for (const qty of [1, 2, 3, 7, 12]) {
        let already = 0;
        let paid = 0;
        while (already < qty) {
          const take = Math.min(qty - already, 1 + (already % 3));
          paid += shareOfUnits(amount, already, take, qty);
          already += take;
        }
        expect(paid).toBe(amount);
      }
    }
  });

  it("never returns more than the line holds when asked for surplus units", () => {
    expect(shareOfUnits(500, 2, 5, 3)).toBe(shareOfUnits(500, 2, 1, 3));
  });
});
