import { randomUUID } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  db,
  feeAssessments,
  organizations,
  usageRecords,
  type DbHandle,
  type FeeAssessment,
} from "../db";
import type { ProductClass } from "../commerce/product-class";
import { entitlementsFor } from "../plans";
import { computeThresholdFee } from "./fees";
import { trailing12Start } from "./meter";

/**
 * Period close (`docs/PRICING.md` §4.5) — the authoritative recompute.
 *
 * The meter recomputes from the ledger on every request, which is right for a
 * live number. **What a merchant was assessed must stop moving**, so closing a
 * period freezes it into `fee_assessments` with the inputs that produced it.
 *
 * This is built now, before Stripe, for the same reason the usage ledger was
 * built before billing: a fee history reconstructed later from mutated orders is
 * lossy and unarguable. A merchant asking "why this number" three months from
 * now gets the row, not a recomputation that may no longer agree.
 *
 * §4.4 governs what happens when records arrive late: the *next* period carries
 * the credit, at the rate originally charged. Nothing rewrites a closed one.
 */

export type CloseResult = {
  /** Null only when the period was genuinely empty and nothing was assessed. */
  assessmentId: string | null;
  orgId: string;
  periodStart: string;
  periodEnd: string;
  billableMinor: number;
  feeMinor: number;
  currency: string;
  recordCount: number;
  /** True when this period was already closed and the existing row was returned. */
  alreadyClosed: boolean;
  /**
   * Always false from a fresh close — an assessment is a measurement, not an
   * invoice. `billing.invoiceAssessments` is what flips it, as a second step the
   * sweep runs after this one so a Stripe failure cannot corrupt the number.
   */
  invoiced: boolean;
  /**
   * One entry per fee class assessed. `feeMinor` above is their **sum**, never a
   * recomputation from combined sales — each class crossed its own threshold at
   * its own rate (`docs/PRICING.md` §3).
   */
  byClass: {
    productClass: ProductClass | null;
    assessmentId: string;
    billableMinor: number;
    feeMinor: number;
    overageRateBps: number;
    t12NetSalesMinor: number;
    periodNetSalesMinor: number;
    recordCount: number;
  }[];
};

/**
 * Closes one period for one org.
 *
 * Idempotent by construction: the unique key on `(orgId, periodStart)` means a
 * retried close returns the existing assessment rather than writing a second
 * one. Double-assessing is a billing dispute with a merchant, and close **is**
 * driven by a scheduler that retries — `GET /api/cron/billing` (§25), via the
 * `billing.closePeriod` action.
 *
 * That same idempotency is why the caller must never hand this a period that has
 * not ended: a partial month would be frozen, and every later attempt would
 * return the frozen row rather than assessing the rest. `billing.closePeriod`
 * refuses that case; nothing here can detect it, since a period is just a pair
 * of dates by the time it arrives.
 */
export async function closePeriod(input: {
  orgId: string;
  periodStart: Date;
  periodEnd: Date;
  handle?: DbHandle;
}): Promise<CloseResult> {
  const handle = input.handle ?? db;

  const existingRows = await handle
    .select()
    .from(feeAssessments)
    .where(
      and(
        eq(feeAssessments.orgId, input.orgId),
        eq(feeAssessments.periodStart, input.periodStart),
      ),
    );

  if (existingRows.length > 0) {
    return summariseClose(existingRows, true);
  }

  const [org] = await handle
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);
  if (!org) throw new Error(`Organization ${input.orgId} not found`);

  const entitlements = entitlementsFor(org);

  /**
   * Production only, and converted amounts only — the same two exclusions the
   * meter applies, for the same reasons: test orders never count (§4.1), and a
   * record with no FX conversion is a known gap rather than a zero.
   */
  const production = (from: Date, to: Date) =>
    and(
      eq(usageRecords.orgId, input.orgId),
      eq(usageRecords.environment, "production"),
      gte(usageRecords.occurredAt, from),
      lt(usageRecords.occurredAt, to),
    );

  /**
   * Summed **per fee class**, because physical and digital run against separate
   * thresholds at different rates (`docs/PRICING.md` §3). A blended rate would
   * be a number no merchant is actually charged.
   */
  const classTotals = async (from: Date, to: Date) => {
    const rows = await handle
      .select({
        productClass: usageRecords.productClass,
        total: sql<string>`coalesce(sum(${usageRecords.convertedMinor}), 0)`,
        n: sql<number>`count(*)::int`,
      })
      .from(usageRecords)
      .where(production(from, to))
      .groupBy(usageRecords.productClass);

    const out: Record<ProductClass, { total: number; count: number }> = {
      physical: { total: 0, count: 0 },
      digital: { total: 0, count: 0 },
    };
    for (const row of rows) {
      // Unclassified records predate the split and belong to neither meter.
      if (row.productClass == null) continue;
      out[row.productClass] = { total: Number(row.total), count: Number(row.n) };
    }
    return out;
  };

  const t12ByClass = await classTotals(trailing12Start(input.periodEnd), input.periodEnd);
  const periodByClass = await classTotals(input.periodStart, input.periodEnd);

  const written: FeeAssessment[] = [];
  for (const cls of ["physical", "digital"] as const) {
    const t12 = t12ByClass[cls].total;
    const periodNet = periodByClass[cls].total;

    const fee = computeThresholdFee({
      t12NetSalesMinor: t12,
      periodNetSalesMinor: periodNet,
      thresholdMinor: entitlements.gmvThresholdMinor,
      overageRateBps: entitlements.overageRateBps[cls],
    });

    /**
     * A class with no activity writes no assessment. An empty row would claim a
     * measurement was taken of something that never happened, and it would show
     * up in invoice history as a zero-value line nobody sold.
     */
    if (periodByClass[cls].count === 0 && fee.feeMinor === 0) continue;

    const id = `fee_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const [row] = await handle
      .insert(feeAssessments)
      .values({
        id,
        orgId: input.orgId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        planId: org.planId,
        productClass: cls,
        thresholdMinor: entitlements.gmvThresholdMinor,
        overageRateBps: entitlements.overageRateBps[cls],
        t12NetSalesMinor: t12,
        periodNetSalesMinor: periodNet,
        billableMinor: fee.billableMinor,
        feeMinor: fee.feeMinor,
        currency: org.currency,
        workings: {
          ...fee.workings,
          excessAtEndMinor: fee.excessAtEndMinor,
          excessAtStartMinor: fee.excessAtStartMinor,
          productClass: cls,
        },
        // Closing bills nothing. The row says so rather than implying an
        // invoice was raised; the sweep's second step is what charges it.
        invoiced: false,
        recordCount: periodByClass[cls].count,
      })
      // Two schedulers racing on the same period must not both assess it.
      .onConflictDoNothing({
        target: [feeAssessments.orgId, feeAssessments.periodStart, feeAssessments.productClass],
      })
      .returning();

    if (row) written.push(row);
  }

  if (written.length === 0) {
    /**
     * Either the period was genuinely empty, or another worker won every race.
     * Re-reading distinguishes them without guessing.
     */
    const raced = await handle
      .select()
      .from(feeAssessments)
      .where(
        and(
          eq(feeAssessments.orgId, input.orgId),
          eq(feeAssessments.periodStart, input.periodStart),
        ),
      );
    return summariseClose(raced, raced.length > 0);
  }

  return summariseClose(written, false);
}

/**
 * Folds per-class assessments into one period result.
 *
 * The fee is the **sum of the classes**, never a recomputation from combined
 * sales: each class crossed its own threshold at its own rate, and re-deriving
 * a total from the sum of sales would silently apply one threshold to both.
 */
function summariseClose(rows: FeeAssessment[], alreadyClosed: boolean): CloseResult {
  const first = rows[0];
  return {
    assessmentId: first?.id ?? null,
    orgId: first?.orgId ?? "",
    periodStart: first?.periodStart.toISOString() ?? "",
    periodEnd: first?.periodEnd.toISOString() ?? "",
    billableMinor: rows.reduce((n, r) => n + r.billableMinor, 0),
    feeMinor: rows.reduce((n, r) => n + r.feeMinor, 0),
    currency: first?.currency ?? "USD",
    recordCount: rows.reduce((n, r) => n + r.recordCount, 0),
    alreadyClosed,
    invoiced: rows.every((r) => r.invoiced) && rows.length > 0,
    byClass: rows.map((r) => ({
      productClass: r.productClass,
      assessmentId: r.id,
      billableMinor: r.billableMinor,
      feeMinor: r.feeMinor,
      overageRateBps: r.overageRateBps,
      t12NetSalesMinor: r.t12NetSalesMinor,
      periodNetSalesMinor: r.periodNetSalesMinor,
      recordCount: r.recordCount,
    })),
  };
}

/**
 * Recomputes a closed period from the ledger and reports any drift.
 *
 * §4.5 asks for a reconciliation with "an alert on drift". This is the check
 * itself — it deliberately **does not** correct the assessment, because a
 * settled number that silently changes is worse than a wrong one somebody can
 * see. Drift means either a late record (a §4.4 credit on the next period) or a
 * bug, and both need a human.
 */
export async function reconcileAssessment(
  assessmentId: string,
  handle: DbHandle = db,
): Promise<{
  assessmentId: string;
  matches: boolean;
  storedFeeMinor: number;
  recomputedFeeMinor: number;
  driftMinor: number;
}> {
  const [row] = await handle
    .select()
    .from(feeAssessments)
    .where(eq(feeAssessments.id, assessmentId))
    .limit(1);
  if (!row) throw new Error(`Assessment ${assessmentId} not found`);

  const production = (from: Date, to: Date) =>
    and(
      eq(usageRecords.orgId, row.orgId),
      eq(usageRecords.environment, "production"),
      gte(usageRecords.occurredAt, from),
      lt(usageRecords.occurredAt, to),
    );

  const [t12Row] = await handle
    .select({ total: sql<string>`coalesce(sum(${usageRecords.convertedMinor}), 0)` })
    .from(usageRecords)
    .where(production(trailing12Start(row.periodEnd), row.periodEnd));
  const [periodRow] = await handle
    .select({ total: sql<string>`coalesce(sum(${usageRecords.convertedMinor}), 0)` })
    .from(usageRecords)
    .where(production(row.periodStart, row.periodEnd));

  // Recomputed on the plan terms **as they were at close**, not today's — a
  // merchant who upgraded since must not have their history re-rated.
  const recomputed = computeThresholdFee({
    t12NetSalesMinor: Number(t12Row?.total ?? 0),
    periodNetSalesMinor: Number(periodRow?.total ?? 0),
    thresholdMinor: row.thresholdMinor,
    overageRateBps: row.overageRateBps,
  });

  return {
    assessmentId: row.id,
    matches: recomputed.feeMinor === row.feeMinor,
    storedFeeMinor: row.feeMinor,
    recomputedFeeMinor: recomputed.feeMinor,
    driftMinor: recomputed.feeMinor - row.feeMinor,
  };
}
