import { NextResponse } from "next/server";
import { ApiError, badRequest, handler } from "@/lib/api";
import { previousPeriod, periodStartingAt } from "@/lib/billing/meter";
import { runBillingSweep } from "@/lib/billing/sweep";
import { authenticateCron } from "@/lib/cron/auth";
import "@/lib/actions";

/**
 * `GET /api/cron/billing` (§23) — the monthly close-and-bill sweep.
 *
 * **This is the job runner the codebase kept saying it did not have.** Every
 * billing surface carried the same caveat — "nothing here is scheduled", "runs
 * when it is invoked" — and it was accurate: a merchant could cross their
 * threshold by any margin and never be charged, because reaching `closePeriod`
 * or `billing.invoiceAssessments` required a human remembering to do it on the
 * right day. The engine was finished. Nothing pressed the button.
 *
 * **Why a `system` actor is safe here, and the one thing that makes it so.**
 * `authorize()` grants a `system` actor every permission and `assertStepUp()`
 * waives its second factor, and both bypasses were justified in comments by the
 * same claim: system actors are "never reachable over HTTP". A cron endpoint is
 * HTTP and nothing else, so this route makes that claim false. `CRON_SECRET`
 * is what replaces it — `lib/cron/auth.ts` is the only code that mints a system
 * actor from a request, it refuses outright when the secret is unset rather than
 * defaulting open, and it compares in constant time. Read that file before
 * changing this one.
 *
 * **On §22 rule 3.** `billing.invoiceAssessments` is `high` risk, which the rule
 * says "always requires human approval and cannot be configured to auto-run".
 * That rule is aimed at an *agent* proposing a charge, and running it here is a
 * deliberate, narrow exception with the same shape as the Stripe webhook that
 * already extends memberships unattended: a platform scheduler operating
 * Markii's own billing cycle on its own timetable, not a caller acting on a
 * merchant's behalf. It is bounded by the fact that the action bills each
 * assessment at most once, refuses every unsafe case individually, and writes an
 * audit row per invocation. See `docs/DECISIONS.md` D41.
 *
 * **GET, not POST.** Vercel Cron issues a GET and offers no way to change that.
 * The method is therefore not a meaningful signal here; the bearer secret is.
 */

/**
 * Node runtime, and it matters: `timingSafeEqual` and the billing path's
 * Postgres driver are both Node APIs.
 */
export const runtime = "nodejs";
/** A sweep must never be served from a cache — it is a mutation behind a GET. */
export const dynamic = "force-dynamic";
/**
 * Long enough for a sweep that makes one Stripe round trip per billable
 * assessment. The default would cut a real run off partway; because both steps
 * are idempotent a truncated run is recoverable, but it would still leave
 * merchants unbilled until someone noticed.
 */
export const maxDuration = 300;

export const GET = handler(async (req) => {
  const auth = authenticateCron(req);
  if (!auth.ok) {
    /**
     * Thrown rather than returned so it goes through `errorResponse`, which
     * runs the same `sanitizePublicCopy` every other route's errors get. The
     * refusal copy names `CRON_SECRET` and its fix because that is what an
     * operator needs — and this endpoint is reachable by anyone who guesses the
     * path, so the detailed version belongs in the log and the generic one on
     * the wire.
     */
    console.error(
      `[cron] billing sweep refused (${auth.code}): ${auth.message}` +
        (auth.resolution ? ` — ${auth.resolution}` : ""),
    );
    throw new ApiError(
      auth.status === 401 ? "UNAUTHORIZED" : "CONFIGURATION_REQUIRED",
      auth.status,
      auth.message,
      auth.resolution ? { resolution: auth.resolution } : undefined,
    );
  }

  const url = new URL(req.url);

  /**
   * `?dryRun=1` reports what the sweep would do and writes nothing — the same
   * escape hatch every action has, and the only safe way to point this at
   * production data the first time.
   */
  const dryRun = url.searchParams.get("dryRun") === "1";

  /**
   * An explicit period exists for one honest reason: catching up after a run was
   * missed. A deployment that was down on the 1st has no other way to close
   * January, and without it the only remedy is closing every org by hand.
   * `billing.closePeriod` still refuses anything that has not ended, so this
   * cannot be used to freeze a live month.
   */
  const periodParam = url.searchParams.get("period");
  const period = periodParam ? periodStartingAt(new Date(periodParam)) : previousPeriod();

  if (Number.isNaN(period.start.getTime())) {
    throw badRequest(
      `Could not read "${periodParam}" as a date. Use an ISO date inside the period to close, ` +
        "e.g. 2026-07-01.",
    );
  }

  const started = Date.now();
  const result = await runBillingSweep({
    periodStart: period.start,
    periodEnd: period.end,
    actor: auth.actor,
    dryRun,
  });

  /**
   * **200 even when some orgs failed, and the body is where that shows.** A
   * non-2xx would make Vercel retry the whole sweep, re-attempting every org
   * that already succeeded. Both steps are idempotent so that would not double
   * bill, but it would bury the one real failure under a repeated run. The
   * counts are the alerting surface; `orgsFailed > 0` is the thing to watch.
   */
  return NextResponse.json({
    ok: true,
    ...result,
    durationMs: Date.now() - started,
    note: dryRun
      ? "Dry run — nothing was closed and nothing was billed. Assessments that this run would " +
        "have created were rolled back, so the billing step reflects only assessments that " +
        "already existed."
      : undefined,
  });
});
