import "server-only";

import { and, eq, gte, lt } from "drizzle-orm";
import { db, feeAssessments, usageRecords } from "../db";
import { invokeAction } from "../actions/invoke";
import type { Actor } from "../actions/types";

/**
 * The monthly billing sweep — close every finished period, then bill what it
 * measured (`docs/PRICING.md` §4.5, `docs/API.md` §23).
 *
 * **What this fixes is an absence, not a bug.** The threshold fee engine, the
 * meter, period close, and fee invoicing were all built and all correct, and
 * none of them had anything calling them. A merchant could cross their threshold
 * by any margin and never be charged, because the only paths to `closePeriod`
 * and `billing.invoiceAssessments` were a human deciding to invoke them by hand
 * on the right day. Threshold pricing is the product's differentiator, so an
 * unscheduled billing step is the difference between a pricing model and a
 * pricing *page*.
 *
 * **Two steps, in this order, never merged.** Close is a measurement and bills
 * nothing; invoicing turns settled measurements into money. Keeping them
 * separate is what lets the second one fail — no Stripe subscription, a currency
 * mismatch, Stripe unreachable — without corrupting the first. The assessment is
 * already durable, `invoiced` stays `false`, and the next sweep picks it up.
 * A single fused step would have to choose between rolling back a correct
 * measurement and marking an uncharged period as billed.
 *
 * **Every org is attempted independently.** One merchant's failure is one
 * merchant's problem; aborting the run would let a single bad row stop billing
 * for everyone, and the failure would be invisible until someone read the logs.
 */

/** What one organization's sweep did. Failures are outcomes, not exceptions. */
export type OrgSweepOutcome = {
  orgId: string;
  closed: {
    ok: boolean;
    assessmentIds: string[];
    feeMinor: number;
    alreadyClosed: boolean;
    error?: string;
  } | null;
  invoiced: {
    ok: boolean;
    billedCount: number;
    chargedMinor: number;
    /** The org's billing currency — `chargedMinor` is meaningless without it. */
    currency: string;
    skipped: { id: string; reason: string }[];
    /** True only when an invoice item was actually raised on Stripe. */
    charging: boolean;
    error?: string;
  } | null;
};

export type SweepResult = {
  periodStart: string;
  periodEnd: string;
  dryRun: boolean;
  /** Orgs considered for close — those with production usage in the period. */
  orgsConsidered: number;
  orgsClosed: number;
  orgsBilled: number;
  orgsFailed: number;
  /**
   * Totalled **per currency**, never as one number. Billing currency is
   * merchant-set, so a single `chargedMinor` across the run would add JPY yen to
   * USD cents and produce a figure that is not money in any currency (D31).
   */
  chargedByCurrency: Record<string, number>;
  outcomes: OrgSweepOutcome[];
};

/**
 * Orgs with production usage inside the window.
 *
 * Not "every organization": `closePeriod` writes no assessment for a class with
 * no records and a zero fee, so an org with an empty period is guaranteed to
 * produce nothing. Filtering here is therefore exactly equivalent to sweeping
 * all of them, and it keeps a run proportional to merchants who actually sold
 * something rather than to the size of the customer table.
 *
 * `environment` is filtered to production for the same reason the meter and
 * close do it — test orders never count (§4.1), and an org whose only activity
 * was a test order must not be dragged into a billing run.
 */
async function orgsWithUsage(
  periodStart: Date,
  periodEnd: Date,
  onlyOrgId?: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: usageRecords.orgId })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.environment, "production"),
        gte(usageRecords.occurredAt, periodStart),
        lt(usageRecords.occurredAt, periodEnd),
        ...(onlyOrgId ? [eq(usageRecords.orgId, onlyOrgId)] : []),
      ),
    );
  return rows.map((r) => r.orgId);
}

/**
 * Orgs holding any unbilled assessment, whatever period it came from.
 *
 * Deliberately not restricted to the period just closed. An assessment that
 * could not be billed last month — the merchant had no subscription yet, Stripe
 * was down — is still owed, and `assessmentBillable` re-checks every reason on
 * each attempt. Scoping this to the current period would strand those rows
 * permanently, which is precisely the "sits pending forever" failure
 * `lib/billing/fee-invoice.ts` is written to avoid.
 */
async function orgsWithUnbilledAssessments(onlyOrgId?: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: feeAssessments.orgId })
    .from(feeAssessments)
    .where(
      onlyOrgId
        ? and(eq(feeAssessments.invoiced, false), eq(feeAssessments.orgId, onlyOrgId))
        : eq(feeAssessments.invoiced, false),
    );
  return rows.map((r) => r.orgId);
}

/** Scopes the sweep's system actor to one organization. */
function actorFor(base: Actor, orgId: string): Actor {
  return { ...base, orgId };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type CloseResultShape = {
  assessmentId: string | null;
  feeMinor: number;
  alreadyClosed: boolean;
  byClass: { assessmentId: string }[];
};

type InvoiceResultShape = {
  billed: { id: string; feeMinor: number; invoiceItemId: string | null }[];
  skipped: { id: string; reason: string }[];
  chargedMinor: number;
  currency: string;
  charging: boolean;
};

/**
 * Runs the sweep for one finished period.
 *
 * `actor` is the `system` actor minted by `authenticateCron` — passed in rather
 * than constructed here so that the only code able to produce one stays in
 * `lib/cron/auth.ts`, next to the secret that authorises it.
 */
export async function runBillingSweep(input: {
  periodStart: Date;
  periodEnd: Date;
  actor: Actor;
  dryRun?: boolean;
  /**
   * Restricts the whole sweep to one organization.
   *
   * The operator case is retrying a single merchant after a failure, without
   * re-walking every other org's assessments to do it. It is also what makes
   * this route testable against a shared database: an unscoped run closes
   * periods for **every** org present and can raise real Stripe items for any
   * with a live subscription, which is not something a test may do to data it
   * does not own.
   */
  orgId?: string;
}): Promise<SweepResult> {
  const dryRun = input.dryRun ?? false;
  const outcomes = new Map<string, OrgSweepOutcome>();

  const outcomeFor = (orgId: string): OrgSweepOutcome => {
    const existing = outcomes.get(orgId);
    if (existing) return existing;
    const fresh: OrgSweepOutcome = { orgId, closed: null, invoiced: null };
    outcomes.set(orgId, fresh);
    return fresh;
  };

  // ---- Step 1: close ------------------------------------------------------
  const toClose = await orgsWithUsage(input.periodStart, input.periodEnd, input.orgId);

  for (const orgId of toClose) {
    const outcome = outcomeFor(orgId);
    try {
      const run = await invokeAction<CloseResultShape>(
        "billing.closePeriod",
        { periodStart: input.periodStart.toISOString() },
        { actor: actorFor(input.actor, orgId), dryRun },
      );
      const result = run.result;
      outcome.closed = {
        ok: true,
        assessmentIds: result?.byClass.map((c) => c.assessmentId) ?? [],
        feeMinor: result?.feeMinor ?? 0,
        alreadyClosed: result?.alreadyClosed ?? false,
      };
    } catch (e) {
      /**
       * Recorded and stepped over. The next org's period close is entirely
       * independent of this one, and a run that stopped here would silently
       * under-bill every merchant sorted after the failure.
       */
      outcome.closed = {
        ok: false,
        assessmentIds: [],
        feeMinor: 0,
        alreadyClosed: false,
        error: errorMessage(e),
      };
      console.error(`[billing sweep] close failed for org ${orgId}`, e);
    }
  }

  // ---- Step 2: bill -------------------------------------------------------
  /**
   * Re-queried rather than reused from step 1. An org whose close failed has
   * nothing new to bill but may still owe an older assessment, and an org that
   * closed to a zero fee needs the run that marks it settled. Reusing the close
   * list would miss both.
   *
   * On a dry run the close above was rolled back, so this sees only assessments
   * that already existed — which is the honest preview: it shows what would be
   * billed *today*, not what a real run would create and then bill in the same
   * pass. The route says so in its response rather than leaving it to be
   * discovered.
   */
  const toBill = await orgsWithUnbilledAssessments(input.orgId);

  for (const orgId of toBill) {
    const outcome = outcomeFor(orgId);
    try {
      const run = await invokeAction<InvoiceResultShape>(
        "billing.invoiceAssessments",
        {},
        { actor: actorFor(input.actor, orgId), dryRun },
      );
      const result = run.result;
      outcome.invoiced = {
        ok: true,
        billedCount: result?.billed.length ?? 0,
        chargedMinor: result?.chargedMinor ?? 0,
        currency: result?.currency ?? "USD",
        skipped: result?.skipped ?? [],
        charging: result?.charging ?? false,
      };
    } catch (e) {
      outcome.invoiced = {
        ok: false,
        billedCount: 0,
        chargedMinor: 0,
        currency: "USD",
        skipped: [],
        charging: false,
        error: errorMessage(e),
      };
      console.error(`[billing sweep] invoicing failed for org ${orgId}`, e);
    }
  }

  return summariseSweep(input.periodStart, input.periodEnd, dryRun, [...outcomes.values()]);
}

/**
 * Folds per-org outcomes into the run summary.
 *
 * Split out and exported so the counting is unit-testable without a database —
 * the arithmetic that decides whether a run gets reported as healthy is exactly
 * the arithmetic worth testing.
 */
export function summariseSweep(
  periodStart: Date,
  periodEnd: Date,
  dryRun: boolean,
  outcomes: OrgSweepOutcome[],
): SweepResult {
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    dryRun,
    orgsConsidered: outcomes.length,
    /** Newly closed only — an org that was already closed did no work this run. */
    orgsClosed: outcomes.filter((o) => o.closed?.ok && !o.closed.alreadyClosed).length,
    /**
     * Counts orgs where money was actually raised, not orgs where the step
     * merely succeeded. A run that settled nothing but zero-fee periods billed
     * nobody, and reporting it as billing would be the fabricated-success rule.
     */
    orgsBilled: outcomes.filter((o) => o.invoiced?.charging).length,
    orgsFailed: outcomes.filter((o) => o.closed?.ok === false || o.invoiced?.ok === false).length,
    chargedByCurrency: outcomes.reduce<Record<string, number>>((totals, o) => {
      if (!o.invoiced?.ok || o.invoiced.chargedMinor === 0) return totals;
      const code = o.invoiced.currency.toUpperCase();
      totals[code] = (totals[code] ?? 0) + o.invoiced.chargedMinor;
      return totals;
    }, {}),
    outcomes,
  };
}
