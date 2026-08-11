import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db, organizations, usageRecords, type DbHandle } from "../db";
import type { ProductClass } from "../commerce/product-class";
import { entitlementsFor, planCatalog, planPricing } from "../plans";
import {
  computeThresholdFee,
  meterState,
  projectPeriodFee,
  suggestUpgrade,
  type MeterState,
} from "./fees";
import { statusGrantsPlan } from "./mirror";

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
 * The most recently *finished* period — the only one a scheduler may close.
 *
 * Closing freezes a number a merchant is charged for, so it may only ever run
 * against a window that can no longer receive sales. Closing the *current*
 * period would freeze a partial month, and because close is idempotent on
 * `(orgId, periodStart)` the rest of that month would then never be assessed at
 * all — the merchant is undercharged and nothing in the system looks wrong.
 *
 * Derived from `currentPeriod` rather than computed separately so the two can
 * never disagree about where a month begins.
 */
/**
 * The calendar period *containing* an instant.
 *
 * Normalising to the containing month rather than demanding an exact month
 * boundary means a caller who passes `2026-07-15` closes July — the period that
 * instant belongs to, not a different one. Rejecting it instead would only push
 * every caller into duplicating this arithmetic, and the copies would drift from
 * `currentPeriod`.
 */
export function periodStartingAt(within: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(within.getUTCFullYear(), within.getUTCMonth(), 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

export function previousPeriod(now = new Date()): { start: Date; end: Date } {
  const { start: currentStart } = currentPeriod(now);
  const start = new Date(
    Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - 1, 1),
  );
  return { start, end: currentStart };
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
): Promise<NetSalesWindow> {
  const window = and(
    eq(usageRecords.orgId, orgId),
    eq(usageRecords.environment, "production"),
    gte(usageRecords.occurredAt, from),
    lt(usageRecords.occurredAt, to),
  );

  /**
   * Grouped by fee class, because physical and digital meter against **separate
   * thresholds** (`docs/PRICING.md` §3). One combined sum would put a merchant
   * over a line neither class actually crossed.
   */
  const rows = await handle
    .select({
      productClass: usageRecords.productClass,
      total: sql<string>`coalesce(sum(${usageRecords.convertedMinor}), 0)`,
    })
    .from(usageRecords)
    .where(window)
    .groupBy(usageRecords.productClass);

  const byClass: Record<ProductClass, number> = { physical: 0, digital: 0 };
  let unclassifiedMinor = 0;
  for (const row of rows) {
    const amount = Number(row.total);
    /**
     * A null class is money metered before the split existed. It is **not**
     * bucketed into either meter — doing so would move historical sales onto a
     * threshold on a guess. It is reported instead, the same way an
     * unconvertible currency is.
     */
    if (row.productClass == null) unclassifiedMinor += amount;
    else byClass[row.productClass] += amount;
  }

  const [gap] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(usageRecords)
    .where(and(window, isNull(usageRecords.convertedMinor)));

  const [unclassified] = await handle
    .select({ n: sql<number>`count(*)::int` })
    .from(usageRecords)
    .where(and(window, isNull(usageRecords.productClass)));

  return {
    byClass,
    totalMinor: byClass.physical + byClass.digital + unclassifiedMinor,
    unclassifiedMinor,
    unconvertedCount: Number(gap?.n ?? 0),
    unclassifiedCount: Number(unclassified?.n ?? 0),
  };
}

type NetSalesWindow = {
  byClass: Record<ProductClass, number>;
  /** Every class plus anything unclassified — the merchant's real net sales. */
  totalMinor: number;
  unclassifiedMinor: number;
  unconvertedCount: number;
  unclassifiedCount: number;
};

/**
 * One fee class's meter. Physical and digital each get their own, because each
 * runs against its **own** threshold (`docs/PRICING.md` §3) — a merchant can be
 * over on digital and under on physical at the same time, and a single combined
 * meter cannot express that.
 */
export type ClassMeter = {
  productClass: ProductClass;
  trailing12NetSalesMinor: number;
  thresholdMinor: number;
  overageRateBps: number;
  state: MeterState;
  periodNetSalesMinor: number;
  billableThisPeriodMinor: number;
  feeAccruedMinor: number;
  projectedPeriodFeeMinor: number | null;
};

export type UsageMeter = {
  currency: string;
  /** Null until a first production sale exists — never 0, which reads as "nothing sold". */
  trailing12NetSalesMinor: number | null;
  /** The same figure for both classes on a plan; each is measured against it separately. */
  thresholdMinor: number;
  /** Per class, since the rates differ (`docs/PRICING.md` §3). */
  overageRateBps: { physical: number; digital: number };
  /** One meter per fee class. Empty before a first production sale. */
  byClass: ClassMeter[];
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
  /**
   * Records metered before physical and digital split. They are in
   * `trailing12NetSalesMinor` but in **neither** class meter, so the two will
   * not add up to the total — deliberately, and reported rather than hidden.
   */
  unclassifiedRecordCount: number;
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
      byClass: [],
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
      unclassifiedRecordCount: 0,
      billingStatus: billingStatus(org.subscriptionStatus),
    };
  }

  /**
   * **One meter per class, each against its own threshold.** The engine itself
   * is unchanged — it is simply run twice, because the arithmetic of "the slice
   * above the line" is identical whichever line you are measuring.
   */
  const elapsedMs = now.getTime() - period.start.getTime();
  const totalMs = period.end.getTime() - period.start.getTime();

  const byClass: ClassMeter[] = (["physical", "digital"] as const).map((cls) => {
    const rate = entitlements.overageRateBps[cls];
    const t12Class = t12.byClass[cls];
    const periodClass = inPeriod.byClass[cls];

    const fee = computeThresholdFee({
      t12NetSalesMinor: t12Class,
      periodNetSalesMinor: periodClass,
      thresholdMinor: entitlements.gmvThresholdMinor,
      overageRateBps: rate,
    });
    const projection = projectPeriodFee({
      t12NetSalesMinor: t12Class,
      periodNetSalesMinor: periodClass,
      thresholdMinor: entitlements.gmvThresholdMinor,
      overageRateBps: rate,
      elapsedMs,
      totalMs,
    });

    return {
      productClass: cls,
      trailing12NetSalesMinor: t12Class,
      thresholdMinor: entitlements.gmvThresholdMinor,
      overageRateBps: rate,
      state: meterState(t12Class, entitlements.gmvThresholdMinor),
      periodNetSalesMinor: periodClass,
      billableThisPeriodMinor: fee.billableMinor,
      feeAccruedMinor: fee.feeMinor,
      projectedPeriodFeeMinor: projection?.projectedFeeMinor ?? null,
    };
  });

  const feeAccruedMinor = byClass.reduce((n, m) => n + m.feeAccruedMinor, 0);
  const billableThisPeriodMinor = byClass.reduce((n, m) => n + m.billableThisPeriodMinor, 0);
  const anyProjection = byClass.some((m) => m.projectedPeriodFeeMinor != null);
  const projectedPeriodFeeMinor = anyProjection
    ? byClass.reduce((n, m) => n + (m.projectedPeriodFeeMinor ?? 0), 0)
    : null;

  const current = planPricing(org.planId);

  /**
   * The upgrade check runs on the class the merchant actually pays most on.
   * Suggesting a plan on combined sales would recommend upgrades to merchants
   * whose fee is entirely on one side of the split.
   */
  const dominant = byClass.reduce((a, b) => (b.feeAccruedMinor > a.feeAccruedMinor ? b : a));
  const excessNow = Math.max(
    0,
    dominant.trailing12NetSalesMinor - entitlements.gmvThresholdMinor,
  );

  return {
    currency: org.currency,
    trailing12NetSalesMinor: t12.totalMinor,
    thresholdMinor: entitlements.gmvThresholdMinor,
    overageRateBps: entitlements.overageRateBps,
    byClass,
    /** The worse of the two, so a merchant over on either sees it at the top. */
    state: byClass.some((m) => m.state === "above")
      ? "above"
      : byClass.some((m) => m.state === "approaching")
        ? "approaching"
        : "below",
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    periodNetSalesMinor: inPeriod.totalMinor,
    billableThisPeriodMinor,
    feeAccruedMinor,
    projectedPeriodFeeMinor,
    projectionBasis: anyProjection ? "run_rate_to_period_end" : null,
    upgradeSuggestion: suggestUpgrade({
      currentPlanId: org.planId,
      t12NetSalesMinor: dominant.trailing12NetSalesMinor,
      currentAnnualFeeMinor: Math.round((excessNow * dominant.overageRateBps) / 10_000),
      currentMonthlyPriceMinor: current.monthlyPriceMinor,
      candidates: planCatalog().map((p) => ({
        ...p,
        overageRateBps: p.overageRateBps[dominant.productClass],
      })),
    }),
    processorFeesNote,
    dataSource: "production",
    unconvertedRecordCount: t12.unconvertedCount,
    unclassifiedRecordCount: t12.unclassifiedCount,
    billingStatus: billingStatus(org.subscriptionStatus),
  };
}

/**
 * Whether anything is actually being charged.
 *
 * **A credential is not a capability, and this is where that distinction bites.**
 * This previously returned `charging: true` on the mere presence of
 * `STRIPE_SECRET_KEY` — so the moment a key was added to an environment, every
 * merchant's meter began saying "threshold fees are billed on your Markii
 * invoice" with **no subscription, no invoice item, and no charging code behind
 * it**. `/api/billing/subscription`, `/invoices`, and `/payment-method` all
 * still refuse with `503 CONFIGURATION_REQUIRED`, and `fee_assessments.invoiced`
 * is still hardcoded `false`. The claim was false in exactly the way `CLAUDE.md`
 * forbids, and it was invisible until a real key existed.
 *
 * So `charging` is **false until the billing path is actually built**, not until
 * a key appears.
 *
 * **It is now genuinely capable of being true**, and the rule that got it here
 * is unchanged: it reports the *capability*, never the credential.
 * `billing.invoiceAssessments` turns a closed assessment into an invoice item on
 * the merchant's next Markii invoice, so threshold fees really can be charged —
 * but only for an org with a subscription for that line to ride on. An org
 * without one is still measured and still billed nothing, and this has to keep
 * saying so.
 *
 * The distinction that survives from the original bug: **the merchant's own
 * state decides this, not the environment.** Two orgs on the same deployment
 * get different answers, which is exactly the point — `charging` was wrong
 * before because it was a property of the process rather than of the merchant.
 *
 * Saying so on every meter response is the difference between a merchant
 * understanding their bill and being surprised by one later. It is also the §4.4
 * trial framing, which requires the same honesty for a different reason.
 */
function billingStatus(subscriptionStatus: string | null): UsageMeter["billingStatus"] {
  if (!process.env.STRIPE_SECRET_KEY) {
    return {
      charging: false,
      reason:
        "Billing is not connected yet, so nothing is being charged. These figures show what " +
        "would be owed — they are a measurement, not an invoice.",
    };
  }
  if (!statusGrantsPlan(subscriptionStatus ?? "")) {
    return {
      charging: false,
      reason:
        "No active Markii subscription, so nothing is being charged: a threshold fee is added to " +
        "a subscription invoice, and there is no subscription to add it to. These figures show " +
        "what would be owed — they are a measurement, not an invoice.",
    };
  }
  return {
    charging: true,
    reason:
      "Threshold fees above your plan's included volume are added to your Markii subscription " +
      "invoice as a named line. The period in progress is still a projection — only a closed " +
      "period is billed.",
  };
}
