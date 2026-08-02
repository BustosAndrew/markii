import { describe, expect, it } from "vitest";
import {
  APPROACHING_RATIO,
  computeThresholdFee,
  meterState,
  projectPeriodFee,
  roundHalfEven,
  suggestUpgrade,
} from "./fees";

/**
 * The threshold fee engine (`docs/PRICING.md` §4.3) — pure, no database.
 *
 * This decides what a merchant is charged, so the tests assert exact minor-unit
 * amounts rather than ranges, and the worked example from the pricing doc is
 * reproduced verbatim. If that example ever fails, either the code or the
 * published pricing is wrong, and both matter.
 */

describe("roundHalfEven", () => {
  it("rounds away from a tie toward the even neighbour", () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
  });

  it("rounds normally away from ties", () => {
    expect(roundHalfEven(1.4)).toBe(1);
    expect(roundHalfEven(1.6)).toBe(2);
    expect(roundHalfEven(0)).toBe(0);
    expect(roundHalfEven(7)).toBe(7);
  });

  it("does not bias upward across many ties", () => {
    // Half-up would add half a minor unit per tie on average — small per
    // invoice, systematically in Markii's favour across every merchant.
    const ties = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
    const rounded = ties.reduce((s, t) => s + roundHalfEven(t), 0);
    const exact = ties.reduce((s, t) => s + t, 0);
    expect(rounded).toBe(exact);
  });
});

describe("computeThresholdFee", () => {
  it("reproduces the worked example from docs/PRICING.md §4.3", () => {
    // Growth, $750k threshold, 0.4%. Merchant enters the month at $730k T12 and
    // sells $60k: billable $40k, fee $160. The first $20k that month is free.
    const result = computeThresholdFee({
      t12NetSalesMinor: 790_000_00,
      periodNetSalesMinor: 60_000_00,
      thresholdMinor: 750_000_00,
      overageRateBps: 40,
    });
    expect(result.excessAtEndMinor).toBe(40_000_00);
    expect(result.excessAtStartMinor).toBe(0);
    expect(result.billableMinor).toBe(40_000_00);
    expect(result.feeMinor).toBe(160_00);
  });

  it("charges nothing below the threshold", () => {
    const result = computeThresholdFee({
      t12NetSalesMinor: 100_000_00,
      periodNetSalesMinor: 20_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
    });
    expect(result.billableMinor).toBe(0);
    expect(result.feeMinor).toBe(0);
  });

  it("charges only the marginal slice in the month of crossing", () => {
    // Starter, $150k threshold. Enters at $140k, sells $30k → $20k billable,
    // not the whole $30k. This is the product.
    const result = computeThresholdFee({
      t12NetSalesMinor: 170_000_00,
      periodNetSalesMinor: 30_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
    });
    expect(result.billableMinor).toBe(20_000_00);
    expect(result.feeMinor).toBe(100_00);
  });

  it("charges the whole period once fully above the line", () => {
    const result = computeThresholdFee({
      t12NetSalesMinor: 300_000_00,
      periodNetSalesMinor: 30_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
    });
    expect(result.billableMinor).toBe(30_000_00);
    expect(result.feeMinor).toBe(150_00);
  });

  it("never bills more than the period actually sold", () => {
    // A T12 that jumped for some other reason — a correction, a late record —
    // must not produce a bill larger than the month's sales.
    const result = computeThresholdFee({
      t12NetSalesMinor: 500_000_00,
      periodNetSalesMinor: 1_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
    });
    expect(result.billableMinor).toBe(1_000_00);
  });

  it("never produces a negative fee from a refund-heavy period", () => {
    // §4.4 handles this as a credit on the next invoice, not a negative
    // assessment silently netted off this one.
    const result = computeThresholdFee({
      t12NetSalesMinor: 140_000_00,
      periodNetSalesMinor: -20_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
    });
    expect(result.billableMinor).toBe(0);
    expect(result.feeMinor).toBe(0);
  });

  it("charges nothing exactly at the threshold", () => {
    // Crossing means going past, not reaching. A merchant landing exactly on
    // their milestone should not get a bill for it.
    const result = computeThresholdFee({
      t12NetSalesMinor: 150_000_00,
      periodNetSalesMinor: 10_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
    });
    expect(result.billableMinor).toBe(0);
  });

  it("carries its own workings, so an invoice line can show the arithmetic", () => {
    const result = computeThresholdFee({
      t12NetSalesMinor: 200_000_00,
      periodNetSalesMinor: 10_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
    });
    expect(result.workings.formula).toContain("round_half_even");
    expect(result.workings.thresholdMinor).toBe(150_000_00);
  });

  it("returns whole minor units for every rate and amount", () => {
    // A fractional fee would mean a float reached a total (D31).
    for (const bps of [30, 40, 50]) {
      for (const sales of [1, 7, 333, 99_999, 1_234_567]) {
        const r = computeThresholdFee({
          t12NetSalesMinor: 10_000_000_00,
          periodNetSalesMinor: sales,
          thresholdMinor: 0,
          overageRateBps: bps,
        });
        expect(Number.isInteger(r.feeMinor)).toBe(true);
      }
    }
  });
});

describe("meterState", () => {
  it("reports below, approaching, and above", () => {
    expect(meterState(10_000_00, 150_000_00)).toBe("below");
    expect(meterState(150_000_00 * APPROACHING_RATIO, 150_000_00)).toBe("approaching");
    expect(meterState(150_000_01, 150_000_00)).toBe("above");
  });

  it("treats exactly the threshold as not yet above", () => {
    // Consistent with the fee engine charging nothing at the line.
    expect(meterState(150_000_00, 150_000_00)).toBe("approaching");
  });
});

describe("projectPeriodFee", () => {
  it("extrapolates from the elapsed fraction of the period", () => {
    // Half the month gone, $30k sold → $60k projected.
    const p = projectPeriodFee({
      t12NetSalesMinor: 200_000_00,
      periodNetSalesMinor: 30_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
      elapsedMs: 15 * 86_400_000,
      totalMs: 30 * 86_400_000,
    });
    expect(p?.projectedPeriodNetSalesMinor).toBe(60_000_00);
  });

  it("returns null before any time has elapsed", () => {
    // A projection from no data is a guess dressed as a number, and dividing by
    // zero elapsed days would produce Infinity.
    expect(
      projectPeriodFee({
        t12NetSalesMinor: 0,
        periodNetSalesMinor: 0,
        thresholdMinor: 150_000_00,
        overageRateBps: 50,
        elapsedMs: 0,
        totalMs: 30 * 86_400_000,
      }),
    ).toBeNull();
  });

  it("does not extrapolate past the end of the period", () => {
    const p = projectPeriodFee({
      t12NetSalesMinor: 200_000_00,
      periodNetSalesMinor: 40_000_00,
      thresholdMinor: 150_000_00,
      overageRateBps: 50,
      elapsedMs: 40 * 86_400_000,
      totalMs: 30 * 86_400_000,
    });
    expect(p?.projectedPeriodNetSalesMinor).toBe(40_000_00);
  });
});

describe("suggestUpgrade", () => {
  const candidates = [
    { planId: "starter", monthlyPriceMinor: 19_00, gmvThresholdMinor: 150_000_00, overageRateBps: 50 },
    { planId: "growth", monthlyPriceMinor: 49_00, gmvThresholdMinor: 750_000_00, overageRateBps: 40 },
    { planId: "scale", monthlyPriceMinor: 129_00, gmvThresholdMinor: 3_000_000_00, overageRateBps: 30 },
  ];

  it("suggests an upgrade that would genuinely cost the merchant less", () => {
    // Starter at $400k T12: fees are 0.5% of $250k = $1,250/yr. Growth's
    // threshold is $750k, so fees vanish for $360/yr more in subscription.
    const s = suggestUpgrade({
      currentPlanId: "starter",
      t12NetSalesMinor: 400_000_00,
      currentAnnualFeeMinor: 1_250_00,
      currentMonthlyPriceMinor: 19_00,
      candidates,
    });
    expect(s?.planId).toBe("growth");
    expect(s?.projectedAnnualSavingMinor).toBeGreaterThan(0);
  });

  it("suggests nothing when upgrading would cost more", () => {
    // The honest answer for a small merchant is to stay put.
    const s = suggestUpgrade({
      currentPlanId: "starter",
      t12NetSalesMinor: 20_000_00,
      currentAnnualFeeMinor: 0,
      currentMonthlyPriceMinor: 19_00,
      candidates,
    });
    expect(s).toBeNull();
  });

  it("picks the plan with the largest saving, not merely the next one up", () => {
    // At $5M, Scale saves far more than Growth. Suggesting the smaller step
    // would keep more Markii revenue and cost the merchant money.
    const s = suggestUpgrade({
      currentPlanId: "starter",
      t12NetSalesMinor: 5_000_000_00,
      currentAnnualFeeMinor: Math.round(((5_000_000_00 - 150_000_00) * 50) / 10_000),
      currentMonthlyPriceMinor: 19_00,
      candidates,
    });
    expect(s?.planId).toBe("scale");
  });

  it("never suggests a downgrade or the current plan", () => {
    const s = suggestUpgrade({
      currentPlanId: "scale",
      t12NetSalesMinor: 100_000_00,
      currentAnnualFeeMinor: 0,
      currentMonthlyPriceMinor: 129_00,
      candidates,
    });
    expect(s).toBeNull();
  });
});
