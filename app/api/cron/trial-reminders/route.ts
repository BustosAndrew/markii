import { NextResponse } from "next/server";
import { orgsOutOfStanding, sweepTrialReminders } from "@/lib/billing/trial-reminders";
import { authenticateCron } from "@/lib/cron/auth";

/**
 * `GET /api/cron/trial-reminders` (§25) — the daily "your free month is ending"
 * sweep.
 *
 * **The third scheduled job, and it holds as little authority as the second.**
 * `/api/cron/billing` mints a `system` actor because it invokes registry actions
 * that move money; this one sends email and nothing else, so it authenticates
 * with `CRON_SECRET` and then mints no actor at all.
 *
 * **Daily, not hourly.** The warning window is three days wide, so a finer
 * schedule would find the same orgs and skip them on a claim that already
 * happened — queries spent to learn there is nothing to do. Daily also keeps the
 * mail's "ends in N days" honest: an hourly job would send at 03:00 for one
 * merchant and 04:00 for another with no difference in meaning.
 *
 * **It does not enforce anything.** Nothing here flips an account to expired —
 * standing is derived from `free_trial_ends_at` on every request
 * (`lib/billing/standing.ts`), so a storefront goes quiet at the right second
 * whether or not this job ever ran. That separation is the point: if this cron
 * is broken or unscheduled, merchants lose a *warning*, not their store, and
 * nobody is billed or blocked by a job that failed to run.
 *
 * **Answers `200` with counts even when individual sends fail.** Vercel retries
 * a non-2xx, and a retry here would re-scan orgs already claimed.
 */
export const runtime = "nodejs";
/** A sweep must never be cached — it is a mutation behind a GET. */
export const dynamic = "force-dynamic";
/** One send per org, batched at 200; ample, and short of a runaway. */
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = authenticateCron(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.code, message: auth.message, resolution: auth.resolution } },
      { status: auth.status },
    );
  }

  const result = await sweepTrialReminders();
  /**
   * Reported alongside the sends because it is the number that says whether the
   * warning is doing its job. A rising count of silently-dark storefronts is the
   * failure this feature can cause, and it should not need a query to notice.
   */
  const outOfStanding = await orgsOutOfStanding();

  return NextResponse.json({ ok: true, ...result, outOfStanding });
}
