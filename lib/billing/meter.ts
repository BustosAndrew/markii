import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db, organizations, usageRecords, type DbHandle } from "../db";
import { entitlementsFor, planCatalog, planPricing } from "../plans";
import {
  computeThresholdFee,
  meterState,
  projectPeriodFee,
  suggestUpgrade,
  type MeterState,
} from "./fees";

/**
 * The threshold meter (§17 `GET /api/billing/usage`).
 *
 * Reads the **immutable usage ledger**, never a live join over orders
 * (`docs/PRICING.md` §4.5). Orders mutate — a refund, a cancellation, an edit —
 * and a fee recomputed from them would change after it was invoiced. The ledger
 * cannot, which is why it was written at event time with checkout rather than
 * added here.
 *
 * **Test-mode records never count**, and that is enforced at write time as well
 * as filtered here (§4.1). Two independent guards, because a demo store
 * inflating a real merchant's threshold is a billing dispute.
 */

/**
 * The trailing-12-month window, per `docs/PRICING.md` §4.2.
 *
 * Not a calendar year — every January every merchant would reset to zero, which
 * is a self-inflicted revenue cliff for Markii and a strange experience for the
 * merchant. Not a plan anniversary either: merchants game it by re-subscribing,
 * and support ends up explaining two different year concepts.
 */
export function trailing12Start(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d;
}

/** The current monthly billing period. Calendar months until Stripe defines real ones. */
export function currentPeriod(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Net sales over a window, in the org's billing currency.
 *
 * **Records with no conversion are excluded and counted separately.** No FX
 * provider is wired, so a sale in a currency other than the org's billing
 * currency stores `convertedMinor: null` rather than an invented rate. Summing
 * those as zero would understate a merchant's threshold; inventing a rate would
 * corrupt a number that decides what they are charged. So they are reported as
 * a gap, and the meter says so.
 */
async function netSalesBetween(
  handle: DbHandle,
  orgId: string,
  from: Date,
  to: Date,
): Promise<{ netMinor: number; unconvertedCount: number }> {
  const window = and(
    eq(usageRecords.orgId, orgId),
    eq(usageRecords.environment, "production"),
    gte(usageRecords.occurredAt, from),
    lt(usageRecords.occurredAt, to),
  );

  const [converted] = await handle
    .select({ total: sql<string>`coalesce(sum(${usageRecords.convertedMinor}), 0)` })
    .from(usageRecords)
    .where(window);

  const [gap] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(usageRecords)
    .where(and(window, isNull(usageRecords.convertedMinor)));

  return { netMinor: Number(converted?.total ?? 0), unconvertedCount: Number(gap?.n ?? 0) };
}

export type UsageMeter = {
  currency: string;
  /** Null until a first production sale exists — never 0, which reads as "nothing sold". */
  trailing12NetSalesMinor: number | null;
  thresholdMinor: number;
  overageRateBps: number;
  state: MeterState | null;
  period: { start: string; end: string };
  periodNetSalesMinor: number | null;
  billableThisPeriodMinor: number | null;
  feeAccruedMinor: number | null;
  projectedPeriodFeeMinor: number | null;
  projectionBasis: "run_rate_to_period_end" | null;
  upgradeSuggestion: ReturnType<typeof suggestUpgrade>;
  processorFeesNote: string;
  dataSource: "production" | "not_yet_measured";
  /** Records whose currency could not be converted, so the number is known-incomplete. */
  unconvertedRecordCount: number;
  /** What the merchant is actually charged right now, and why. */
  billingStatus: {
    charging: boolean;
    reason: string;
  };
};

/**
 * The meter for one org.
 *
 * Everything is computed from records at read time. `docs/PRICING.md` §4.5 also
 * describes a nightly rollup of `t12_net_sales`, and it is deliberately **not**
 * built: nothing schedules jobs in this deployment yet, and a cache nobody
 * refreshes is worse than the query it replaces. The direct sum is exact, and
 * the indexes it uses (`usage_records_org_occurred_idx`) are the ones a rollup
 * would have been built on anyway.
 */
export async function usageMeterFor(
  orgId: string,
  opts: { now?: Date; handle?: DbHandle } = {},
): Promise<UsageMeter> {
  const now = opts.now ?? new Date();
  const handle = opts.handle ?? db;

  const [org] = await handle
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`Organization ${orgId} not found`);

  const entitlements = entitlementsFor(org);
  const period = currentPeriod(now);

  const t12 = await netSalesBetween(handle, orgId, trailing12Start(now), now);
  const inPeriod = await netSalesBetween(handle, orgId, period.start, now);

  const [everRow] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(usageRecords)
    .where(and(eq(usageRecords.orgId, orgId), eq(usageRecords.environment, "production")));
  const hasProductionSales = Number(everRow?.n ?? 0) > 0;

  const processorFeesNote =
    "Charged by your payment provider, not part of your Markii bill. Markii never marks up " +
    "processor fees and never takes a cut of your payments.";

  /**
   * **Before a first sale, everything is null and `dataSource` says why** (§17).
   * Zeroes would read as "you sold nothing", which is a measurement; this is the
   * absence of one.
   */
  if (!hasProductionSales) {
    return {
      currency: org.currency,
      trailing12NetSalesMinor: null,
      thresholdMinor: entitlements.gmvThresholdMinor,
      overageRateBps: entitlements.overageRateBps,
      state: null,
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      periodNetSalesMinor: null,
      billableThisPeriodMinor: null,
      feeAccruedMinor: null,
      projectedPeriodFeeMinor: null,
      projectionBasis: null,
      upgradeSuggestion: null,
      processorFeesNote,
      dataSource: "not_yet_measured",
      unconvertedRecordCount: 0,
      billingStatus: billingStatus(),
    };
  }

  const fee = computeThresholdFee({
    t12NetSalesMinor: t12.netMinor,
    periodNetSalesMinor: inPeriod.netMinor,
    thresholdMinor: entitlements.gmvThresholdMinor,
    overageRateBps: entitlements.overageRateBps,
  });

  const projection = projectPeriodFee({
    t12NetSalesMinor: t12.netMinor,
    periodNetSalesMinor: inPeriod.netMinor,
    thresholdMinor: entitlements.gmvThresholdMinor,
    overageRateBps: entitlements.overageRateBps,
    elapsedMs: now.getTime() - period.start.getTime(),
    totalMs: period.end.getTime() - period.start.getTime(),
  });

  const current = planPricing(org.planId);
  const excessNow = Math.max(0, t12.netMinor - entitlements.gmvThresholdMinor);

  return {
    currency: org.currency,
    trailing12NetSalesMinor: t12.netMinor,
    thresholdMinor: entitlements.gmvThresholdMinor,
    overageRateBps: entitlements.overageRateBps,
    state: meterState(t12.netMinor, entitlements.gmvThresholdMinor),
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    periodNetSalesMinor: inPeriod.netMinor,
    billableThisPeriodMinor: fee.billableMinor,
    feeAccruedMinor: fee.feeMinor,
    projectedPeriodFeeMinor: projection?.projectedFeeMinor ?? null,
    projectionBasis: projection ? "run_rate_to_period_end" : null,
    upgradeSuggestion: suggestUpgrade({
      currentPlanId: org.planId,
      t12NetSalesMinor: t12.netMinor,
      currentAnnualFeeMinor: Math.round((excessNow * entitlements.overageRateBps) / 10_000),
      currentMonthlyPriceMinor: current.monthlyPriceMinor,
      candidates: planCatalog(),
    }),
    processorFeesNote,
    dataSource: "production",
    unconvertedRecordCount: t12.unconvertedCount,
    billingStatus: billingStatus(),
  };
}

/**
 * Whether anything is actually being charged.
 *
 * Stripe Billing is not wired — no `STRIPE_SECRET_KEY` exists — so fees accrue
 * and display but nothing is collected. Saying so on every meter response is
 * the difference between a merchant understanding their bill and being
 * surprised by one later. It is also the §4.4 trial framing, which requires the
 * same honesty for a different reason.
 */
function billingStatus(): UsageMeter["billingStatus"] {
  const configured = Boolean(process.env.STRIPE_SECRET_KEY);
  return configured
    ? { charging: true, reason: "Threshold fees are billed on your Markii invoice." }
    : {
        charging: false,
        reason:
          "Billing is not connected yet, so nothing is being charged. These figures show what " +
          "would be owed — they are a measurement, not an invoice.",
      };
}
