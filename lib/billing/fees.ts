/**
 * The threshold fee engine (`docs/PRICING.md` §4.3) — pure, so the arithmetic
 * that decides what a merchant is charged can be tested without a database.
 *
 * **The fee is marginal.** Only the slice of *this period's* sales that sits
 * above the trailing-12-month threshold is billable — never the whole month,
 * and never retroactively. That is the product: a Growth merchant crossing
 * $750k mid-month pays on the $40k past the line, not on all $60k they sold.
 * The same merchant on Shopify Grow with Stripe pays 1% of everything, every
 * month, with no threshold at all.
 *
 * Everything here is integer minor units. No float ever reaches a total (D31).
 */

/**
 * Banker's rounding, as `docs/PRICING.md` §4.3 specifies.
 *
 * Half-up would bias every fee upward by half a minor unit on average — small
 * per invoice, systematically in Markii's favour across every merchant and
 * every month. Half-even splits ties toward the even number, so the bias
 * cancels. That it favours nobody is the entire reason to use it.
 */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // Exactly a half: go to whichever neighbour is even.
  return floor % 2 === 0 ? floor : floor + 1;
}

export type FeeInput = {
  /** Trailing 12-month net sales as of period end, in billing-currency minor units. */
  t12NetSalesMinor: number;
  /** Net sales within this billing period. */
  periodNetSalesMinor: number;
  /** The plan's annual threshold. */
  thresholdMinor: number;
  /** Basis points on the billable slice. 50 = 0.50%. */
  overageRateBps: number;
};

export type FeeResult = {
  /** How far past the threshold the merchant sits at period end. */
  excessAtEndMinor: number;
  /** How far past it they sat at period start. */
  excessAtStartMinor: number;
  /** The slice of this period's sales above the line. */
  billableMinor: number;
  feeMinor: number;
  /** Every input, echoed, so an invoice line can show its own arithmetic. */
  workings: FeeInput & { formula: string };
};

/**
 * The fee for one closed period.
 *
 * `billable` is capped at `periodNetSalesMinor` because the excess can only
 * have come from this period's sales — without the cap, a merchant whose T12
 * jumped for any other reason (a correction, a late-arriving record) could be
 * billed for more than they sold.
 */
export function computeThresholdFee(input: FeeInput): FeeResult {
  const excessAtEnd = Math.max(0, input.t12NetSalesMinor - input.thresholdMinor);
  const excessAtStart = Math.max(
    0,
    input.t12NetSalesMinor - input.periodNetSalesMinor - input.thresholdMinor,
  );

  /**
   * Floored at zero as well as capped. A period of net *refunds* pushes T12
   * down, making the difference negative — that is a credit question
   * (§4.4: "credit the fee on the next invoice at the rate originally
   * charged"), not a negative fee silently netted off this one.
   */
  const billable = Math.max(0, Math.min(input.periodNetSalesMinor, excessAtEnd - excessAtStart));

  return {
    excessAtEndMinor: excessAtEnd,
    excessAtStartMinor: excessAtStart,
    billableMinor: billable,
    feeMinor: roundHalfEven((billable * input.overageRateBps) / 10_000),
    workings: {
      ...input,
      formula:
        "billable = min(period_sales, max(0, T12 − threshold) − max(0, (T12 − period_sales) − threshold)); " +
        "fee = round_half_even(billable × rate_bps / 10000)",
    },
  };
}

export type MeterState = "below" | "approaching" | "above";

/** Within this fraction of the threshold, a merchant is told they are close. */
export const APPROACHING_RATIO = 0.8;

export function meterState(t12NetSalesMinor: number, thresholdMinor: number): MeterState {
  if (t12NetSalesMinor > thresholdMinor) return "above";
  if (t12NetSalesMinor >= thresholdMinor * APPROACHING_RATIO) return "approaching";
  return "below";
}

/**
 * Extrapolates the period's fee from how it is going so far.
 *
 * **Always a projection, never an amount owed** (§17). It assumes the rest of
 * the period looks like the part already elapsed, which is exactly the
 * assumption a merchant needs told: `projectionBasis` is returned alongside so
 * no surface can present this as a bill.
 *
 * Returns null before any elapsed time — dividing by zero days would produce
 * Infinity, and a projection from no data is a guess dressed as a number.
 */
export function projectPeriodFee(input: {
  t12NetSalesMinor: number;
  periodNetSalesMinor: number;
  thresholdMinor: number;
  overageRateBps: number;
  elapsedMs: number;
  totalMs: number;
}): { projectedFeeMinor: number; projectedPeriodNetSalesMinor: number } | null {
  if (input.elapsedMs <= 0 || input.totalMs <= 0) return null;

  const fraction = Math.min(1, input.elapsedMs / input.totalMs);
  const projectedPeriodSales = Math.round(input.periodNetSalesMinor / fraction);
  // T12 grows by whatever the rest of the period is projected to add.
  const projectedT12 = input.t12NetSalesMinor + (projectedPeriodSales - input.periodNetSalesMinor);

  const { feeMinor } = computeThresholdFee({
    t12NetSalesMinor: projectedT12,
    periodNetSalesMinor: projectedPeriodSales,
    thresholdMinor: input.thresholdMinor,
    overageRateBps: input.overageRateBps,
  });

  return { projectedFeeMinor: feeMinor, projectedPeriodNetSalesMinor: projectedPeriodSales };
}

export type UpgradeSuggestion = {
  planId: string;
  monthlyDeltaMinor: number;
  projectedAnnualSavingMinor: number;
};

/**
 * Whether a higher plan would cost this merchant less.
 *
 * **Surfaced even when it lowers Markii's revenue** (§17). A merchant paying
 * more in threshold fees than an upgrade would cost is a merchant who will
 * eventually work that out for themselves, and discover Markii let them
 * overpay in the meantime. The design intent in `docs/PRICING.md` §3 is that a
 * growing merchant's cheapest move is always to upgrade — this is what makes
 * that true in practice rather than only on paper.
 */
export function suggestUpgrade(input: {
  currentPlanId: string;
  t12NetSalesMinor: number;
  /** Annualised fee on the current plan, in minor units. */
  currentAnnualFeeMinor: number;
  /** Candidates, cheapest first, with monthly price and threshold terms. */
  candidates: {
    planId: string;
    monthlyPriceMinor: number;
    gmvThresholdMinor: number;
    overageRateBps: number;
  }[];
  currentMonthlyPriceMinor: number;
}): UpgradeSuggestion | null {
  let best: UpgradeSuggestion | null = null;

  for (const candidate of input.candidates) {
    if (candidate.planId === input.currentPlanId) continue;
    if (candidate.monthlyPriceMinor <= input.currentMonthlyPriceMinor) continue;

    // What a year at this run-rate would cost in fees on the candidate plan.
    const excess = Math.max(0, input.t12NetSalesMinor - candidate.gmvThresholdMinor);
    const candidateAnnualFee = roundHalfEven((excess * candidate.overageRateBps) / 10_000);

    const extraSubscription =
      (candidate.monthlyPriceMinor - input.currentMonthlyPriceMinor) * 12;
    const saving = input.currentAnnualFeeMinor - candidateAnnualFee - extraSubscription;

    if (saving > 0 && (!best || saving > best.projectedAnnualSavingMinor)) {
      best = {
        planId: candidate.planId,
        monthlyDeltaMinor: candidate.monthlyPriceMinor - input.currentMonthlyPriceMinor,
        projectedAnnualSavingMinor: saving,
      };
    }
  }

  return best;
}
