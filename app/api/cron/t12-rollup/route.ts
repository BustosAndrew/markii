import { NextResponse } from "next/server";
import { runRollup } from "@/lib/billing/rollup";
import { authenticateCron } from "@/lib/cron/auth";

/**
 * `GET /api/cron/t12-rollup` (§25, `docs/PRICING.md` §4.5) — the nightly
 * trailing-twelve refresh.
 *
 * **The fourth scheduled job, and the only one that changes no merchant-facing
 * state.** It writes a cache in front of a query that is already exact, so the
 * worst it can do by failing is make the meter compute what it computed before
 * the cache existed. That is why it authenticates with `CRON_SECRET` and then
 * mints **no actor at all**: it invokes no registry action, moves no money,
 * grants no access, and sends no mail. `/api/cron/billing` is the only job that
 * needs a `system` actor, and it needs one because it bills people.
 *
 * **Nightly, not hourly.** The window is a rolling year; an hour of movement in
 * it is noise, and refreshing hourly would spend a full-year aggregate per org
 * per hour to chase a figure that changes by fractions of a percent. The reader
 * tolerates a day (`MAX_ROLLUP_AGE_MS` is 26 hours, deliberately wider than the
 * interval so a late run does not read as stale).
 *
 * **Scheduled at 02:00, an hour ahead of the billing sweep**, so on the 1st of
 * the month period close compares against a cache written an hour earlier rather
 * than a day. That ordering is a convenience, not a dependency: `closePeriod`
 * recomputes from records regardless, and the drift check reports rather than
 * repairs, so a rollup that failed that night makes the comparison less useful
 * and the bill no less correct.
 *
 * **Answers `200` with counts even when individual orgs fail.** A non-2xx makes
 * Vercel retry the whole sweep, which would re-aggregate every org that already
 * succeeded to reach the one that did not. Failures are reported per org.
 */
export const runtime = "nodejs";
/** A sweep must never be cached — it is a mutation behind a GET. */
export const dynamic = "force-dynamic";
/** One full-year aggregate per org with production sales. */
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = authenticateCron(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.code, message: auth.message, resolution: auth.resolution } },
      { status: auth.status },
    );
  }

  const result = await runRollup(new Date());

  /**
   * `orgsFailed` is the number worth watching. An org that keeps failing keeps
   * its old row until it ages past `MAX_ROLLUP_AGE_MS`, after which the meter
   * simply goes back to summing live — correct, slower, and invisible from the
   * outside. This count is the only place that degradation is legible.
   */
  return NextResponse.json(result);
}
