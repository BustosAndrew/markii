import { randomUUID } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, feeAssessments, organizations, usageRecords, type DbHandle } from "../db";
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
  assessmentId: string;
  orgId: string;
  periodStart: string;
  periodEnd: string;
  billableMinor: number;
  feeMinor: number;
  currency: string;
  recordCount: number;
  /** True when this period was already closed and the existing row was returned. */
  alreadyClosed: boolean;
  /** False while Stripe is unwired — an assessment is a measurement, not an invoice. */
  invoiced: boolean;
};

/**
 * Closes one period for one org.
 *
 * Idempotent by construction: the unique key on `(orgId, periodStart)` means a
 * retried close returns the existing assessment rather than writing a second
 * one. Double-assessing is a billing dispute with a merchant, and close will be
 * driven by a scheduler that retries.
 */
export async function closePeriod(input: {
  orgId: string;
  periodStart: Date;
  periodEnd: Date;
  handle?: DbHandle;
}): Promise<CloseResult> {
  const handle = input.handle ?? db;

  const [existing] = await handle
    .select()
    .from(feeAssessments)
    .where(
      and(
        eq(feeAssessments.orgId, input.orgId),
        eq(feeAssessments.periodStart, input.periodStart),
      ),
    )
    .limit(1);

  if (existing) {
    return {
      assessmentId: existing.id,
      orgId: existing.orgId,
      periodStart: existing.periodStart.toISOString(),
      periodEnd: existing.periodEnd.toISOString(),
      billableMinor: existing.billableMinor,
      feeMinor: existing.feeMinor,
      currency: existing.currency,
      recordCount: existing.recordCount,
      alreadyClosed: true,
      invoiced: existing.invoiced,
    };
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

  const [t12Row] = await handle
    .select({ total: sql<string>`coalesce(sum(${usageRecords.convertedMinor}), 0)` })
    .from(usageRecords)
    .where(production(trailing12Start(input.periodEnd), input.periodEnd));

  const [periodRow] = await handle
    .select({
      total: sql<string>`coalesce(sum(${usageRecords.convertedMinor}), 0)`,
      n: sql<number>`count(*)::int`,
    })
    .from(usageRecords)
    .where(production(input.periodStart, input.periodEnd));

  const t12 = Number(t12Row?.total ?? 0);
  const periodNet = Number(periodRow?.total ?? 0);

  const fee = computeThresholdFee({
    t12NetSalesMinor: t12,
    periodNetSalesMinor: periodNet,
    thresholdMinor: entitlements.gmvThresholdMinor,
    overageRateBps: entitlements.overageRateBps,
  });

  const id = `fee_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  const [row] = await handle
    .insert(feeAssessments)
    .values({
      id,
      orgId: input.orgId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      planId: org.planId,
      thresholdMinor: entitlements.gmvThresholdMinor,
      overageRateBps: entitlements.overageRateBps,
      t12NetSalesMinor: t12,
      periodNetSalesMinor: periodNet,
      billableMinor: fee.billableMinor,
      feeMinor: fee.feeMinor,
      currency: org.currency,
      workings: { ...fee.workings, excessAtEndMinor: fee.excessAtEndMinor, excessAtStartMinor: fee.excessAtStartMinor },
      // Nothing is billed while Stripe is unconnected, and the row says so
      // rather than implying an invoice was raised.
      invoiced: false,
      recordCount: Number(periodRow?.n ?? 0),
    })
    // Two schedulers racing on the same period must not both assess it.
    .onConflictDoNothing({ target: [feeAssessments.orgId, feeAssessments.periodStart] })
    .returning();

  if (!row) {
    // Lost the race; the winner's row is authoritative.
    return closePeriod(input);
  }

  return {
    assessmentId: row.id,
    orgId: row.orgId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    billableMinor: row.billableMinor,
    feeMinor: row.feeMinor,
    currency: row.currency,
    recordCount: row.recordCount,
    alreadyClosed: false,
    invoiced: row.invoiced,
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
