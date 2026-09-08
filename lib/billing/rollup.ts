import "server-only";

import { and, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { db, t12NetSales, usageRecords, type DbHandle } from "../db";

/**
 * The nightly trailing-twelve rollup (`docs/PRICING.md` §4.5).
 *
 * **This is a cache in front of an exact query, and every decision here follows
 * from that.** `usageMeterFor` sums `usage_records` directly and is always
 * right; it just sums a year of rows to do it. This job precomputes that sum so
 * the dashboard does not, and nothing else changes: period close still
 * recomputes from records (`close.ts`), and `fee_assessments` remains what a
 * merchant is billed against.
 *
 * It was deliberately unbuilt until 2026-09-08 — "a cache nobody refreshes is
 * worse than the query it replaces". Two things make it safe now. Something
 * refreshes it (§25), and **the reader can tell when it is stale**: every row
 * carries `computedAt`, `readT12` refuses anything older than
 * {@link MAX_ROLLUP_AGE_MS}, and the meter falls back to the live sum. A cron
 * that silently stops therefore costs performance, never correctness — the
 * failure mode is yesterday's behaviour, not yesterday's numbers presented as
 * today's.
 *
 * **`docs/BACKEND.md` asks for an alert on drift between the rollup and the
 * authoritative recompute.** {@link driftFor} is that comparison; the sweep runs
 * it at period close, where the exact figure is being computed anyway and the
 * comparison is therefore free.
 */

/**
 * How old a rollup may be before the meter ignores it.
 *
 * Twenty-six hours, not twenty-four: the job runs daily, and a window equal to
 * the interval would call a row stale every time the run drifted by a minute.
 * The margin is what stops a healthy deployment flapping between cached and live
 * numbers for reasons a merchant would experience as the figure changing.
 */
export const MAX_ROLLUP_AGE_MS = 26 * 60 * 60 * 1000;

/** The trailing-twelve window ending now. Shared so writer and reader agree. */
export function trailingWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  return { start, end: now };
}

export type RollupRow = {
  productClass: "physical" | "digital" | null;
  netSalesMinor: number;
  unconvertedCount: number;
  unclassifiedCount: number;
};

/**
 * Computes one org's trailing-twelve sums straight from the ledger.
 *
 * Deliberately the *same shape* the meter derives, and deliberately not shared
 * code with it: the meter's version is the authority, and a rollup that reused
 * it would be unable to disagree — which would make {@link driftFor} incapable
 * of ever finding anything. Two independent paths that must agree is the point.
 */
export async function computeT12(
  orgId: string,
  now: Date,
  handle: DbHandle = db,
): Promise<RollupRow[]> {
  const { start, end } = trailingWindow(now);
  const window = and(
    eq(usageRecords.orgId, orgId),
    eq(usageRecords.environment, "production"),
    gte(usageRecords.occurredAt, start),
    lt(usageRecords.occurredAt, end),
  );

  const sums = await handle
    .select({
      productClass: usageRecords.productClass,
      total: sql<string>`coalesce(sum(${usageRecords.convertedMinor}), 0)`,
      unconverted: sql<number>`count(*) filter (where ${usageRecords.convertedMinor} is null)::int`,
      unclassified: sql<number>`count(*) filter (where ${usageRecords.productClass} is null)::int`,
    })
    .from(usageRecords)
    .where(window)
    .groupBy(usageRecords.productClass);

  return sums.map((r) => ({
    productClass: r.productClass ?? null,
    netSalesMinor: Number(r.total),
    unconvertedCount: Number(r.unconverted ?? 0),
    unclassifiedCount: Number(r.unclassified ?? 0),
  }));
}

/**
 * Writes one org's rollup.
 *
 * **Deletes the classes that no longer appear.** A merchant who sold digital
 * goods last year and none in the trailing window must not keep a stale digital
 * row: the sum for that class is genuinely zero now, and leaving the old figure
 * would report revenue that has aged out of the window as current.
 */
export async function writeRollup(
  orgId: string,
  now: Date,
  handle: DbHandle = db,
): Promise<{ rows: number }> {
  const rows = await computeT12(orgId, now, handle);
  const { start, end } = trailingWindow(now);

  /**
   * Replace wholesale rather than upsert-and-reconcile.
   *
   * A class can *leave* the window — a merchant who sold digital goods thirteen
   * months ago and none since — and an upsert would leave that old figure in
   * place, reporting revenue that has aged out as current. Deleting first makes
   * the row set exactly what the window contains, with no reconciliation logic
   * to get wrong.
   *
   * The momentary gap between delete and insert is safe precisely because this
   * is a cache: `readT12` returns null when it finds no rows, and the meter
   * falls back to the live sum. A reader landing mid-write gets the exact
   * number, which is the same thing it got before this table existed.
   */
  await handle.delete(t12NetSales).where(eq(t12NetSales.orgId, orgId));

  if (rows.length > 0) {
    await handle.insert(t12NetSales).values(
      rows.map((row) => ({
        orgId,
        productClass: row.productClass,
        netSalesMinor: row.netSalesMinor,
        unconvertedCount: row.unconvertedCount,
        unclassifiedCount: row.unclassifiedCount,
        windowStart: start,
        windowEnd: end,
        computedAt: now,
      })),
    );
  }

  return { rows: rows.length };
}

export type CachedT12 = {
  byClass: { physical: number; digital: number };
  unclassifiedMinor: number;
  unconvertedCount: number;
  unclassifiedCount: number;
  computedAt: Date;
};

/**
 * Reads the cache, or returns null when it cannot be trusted.
 *
 * Null on absent **and** on stale, so the caller has one branch rather than two
 * and cannot accidentally use an old row by forgetting to check the timestamp.
 * The staleness rule lives here rather than at the call site for the same
 * reason `orgHandler` owns authentication: a check every caller must remember is
 * a check some caller will forget.
 */
export async function readT12(
  orgId: string,
  now: Date,
  handle: DbHandle = db,
): Promise<CachedT12 | null> {
  const rows = await handle.select().from(t12NetSales).where(eq(t12NetSales.orgId, orgId));
  if (rows.length === 0) return null;

  const oldest = rows.reduce(
    (min, r) => (r.computedAt < min ? r.computedAt : min),
    rows[0].computedAt,
  );
  if (now.getTime() - oldest.getTime() > MAX_ROLLUP_AGE_MS) return null;

  const byClass = { physical: 0, digital: 0 };
  let unclassifiedMinor = 0;
  let unconvertedCount = 0;
  let unclassifiedCount = 0;
  for (const r of rows) {
    if (r.productClass === null) unclassifiedMinor += r.netSalesMinor;
    else byClass[r.productClass] += r.netSalesMinor;
    unconvertedCount += r.unconvertedCount;
    unclassifiedCount += r.unclassifiedCount;
  }
  return { byClass, unclassifiedMinor, unconvertedCount, unclassifiedCount, computedAt: oldest };
}

export type Drift = {
  orgId: string;
  productClass: "physical" | "digital" | null;
  cachedMinor: number;
  actualMinor: number;
  differenceMinor: number;
};

/**
 * Compares the cache against a fresh computation (`docs/BACKEND.md`).
 *
 * **Reports, never repairs.** A drift means one of the two paths is wrong, and
 * silently overwriting the cache would destroy the only evidence of which —
 * turning a bug that announces itself into one that heals just fast enough never
 * to be noticed. The sweep records what this returns; the next nightly run
 * rewrites the row anyway.
 *
 * An absent cache is not drift. It is a merchant the job has never covered — a
 * new org, or one whose first sale landed after the last run — and reporting
 * that as a discrepancy would bury the real ones.
 */
export async function driftFor(
  orgId: string,
  now: Date,
  handle: DbHandle = db,
): Promise<Drift[]> {
  const cached = await handle.select().from(t12NetSales).where(eq(t12NetSales.orgId, orgId));
  if (cached.length === 0) return [];

  const actual = await computeT12(orgId, now, handle);
  const key = (c: "physical" | "digital" | null) => c ?? "unclassified";

  const actualByClass = new Map(actual.map((a) => [key(a.productClass), a.netSalesMinor]));
  const seen = new Set<string>();
  const drifts: Drift[] = [];

  for (const row of cached) {
    seen.add(key(row.productClass));
    const actualMinor = actualByClass.get(key(row.productClass)) ?? 0;
    if (actualMinor !== row.netSalesMinor) {
      drifts.push({
        orgId,
        productClass: row.productClass,
        cachedMinor: row.netSalesMinor,
        actualMinor,
        differenceMinor: actualMinor - row.netSalesMinor,
      });
    }
  }

  // A class the ledger has and the cache does not is drift in the other
  // direction — revenue the meter would have under-reported.
  for (const a of actual) {
    if (seen.has(key(a.productClass)) || a.netSalesMinor === 0) continue;
    drifts.push({
      orgId,
      productClass: a.productClass,
      cachedMinor: 0,
      actualMinor: a.netSalesMinor,
      differenceMinor: a.netSalesMinor,
    });
  }

  return drifts;
}

/**
 * Orgs worth rolling up: those with any production usage in the window.
 *
 * Not every organization — an org with no records sums to zero, and writing a
 * row of zeroes for it would grow the table with the customer list rather than
 * with merchants who sell. It matches how the billing sweep chooses its orgs.
 */
export async function orgsWithTrailingUsage(now: Date, handle: DbHandle = db): Promise<string[]> {
  const { start, end } = trailingWindow(now);
  const rows = await handle
    .selectDistinct({ orgId: usageRecords.orgId })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.environment, "production"),
        gte(usageRecords.occurredAt, start),
        lt(usageRecords.occurredAt, end),
      ),
    );
  return rows.map((r) => r.orgId);
}

export type RollupRunResult = {
  ranAt: string;
  orgsConsidered: number;
  orgsRolledUp: number;
  orgsFailed: number;
  failures: { orgId: string; error: string }[];
  /** Rows for orgs that no longer have usage in the window, removed. */
  orgsPruned: number;
};

/**
 * The nightly job.
 *
 * **Per-org failures are stepped over, not thrown.** One merchant's bad row must
 * not stop every other merchant's meter from being refreshed — and because a
 * failed org simply keeps its previous row, which `readT12` will reject once it
 * ages out, the consequence of a persistent failure is a live query rather than
 * a wrong number.
 */
export async function runRollup(now: Date, handle: DbHandle = db): Promise<RollupRunResult> {
  const orgIds = await orgsWithTrailingUsage(now, handle);
  const failures: { orgId: string; error: string }[] = [];
  let rolledUp = 0;

  for (const orgId of orgIds) {
    try {
      await writeRollup(orgId, now, handle);
      rolledUp++;
    } catch (e) {
      failures.push({ orgId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Rows for orgs that dropped out of the window entirely. Without this the
   * table keeps a figure that aged out of the trailing year and reports it
   * forever — the same staleness the freshness stamp guards against, arriving
   * through a row that stops being updated rather than one that is old.
   */
  let orgsPruned = 0;
  if (orgIds.length > 0) {
    const stale = await handle
      .select({ orgId: t12NetSales.orgId })
      .from(t12NetSales)
      .where(notInArray(t12NetSales.orgId, orgIds));
    const uniqueStale = [...new Set(stale.map((r) => r.orgId))];
    if (uniqueStale.length > 0) {
      await handle.delete(t12NetSales).where(inArray(t12NetSales.orgId, uniqueStale));
      orgsPruned = uniqueStale.length;
    }
  }

  return {
    ranAt: now.toISOString(),
    orgsConsidered: orgIds.length,
    orgsRolledUp: rolledUp,
    orgsFailed: failures.length,
    failures,
    orgsPruned,
  };
}
