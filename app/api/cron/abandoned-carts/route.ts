import { NextResponse } from "next/server";
import { authenticateCron } from "@/lib/cron/auth";
import { sweepAbandonedCarts } from "@/lib/email/abandoned-carts";

/**
 * `GET /api/cron/abandoned-carts` (§25) — hourly recovery-mail sweep.
 *
 * **The second scheduled job in the codebase**, and deliberately far less
 * powerful than the first. `/api/cron/billing` mints a `system` actor because it
 * invokes registry actions that move money; this one calls a single function
 * that sends email, so it authenticates with the same secret and then mints
 * nothing at all. A cron endpoint should hold the least authority that does the
 * job, and here that is none.
 *
 * **Hourly, not per minute.** The window is an hour wide (`QUIET_FOR_MS`), so a
 * finer schedule would find the same carts and skip them — spending queries to
 * discover there is nothing to do.
 *
 * **It answers `200` with counts even when individual sends fail.** Vercel
 * retries a non-2xx, and a retry here would re-scan carts that were already
 * claimed — wasted work at best. Per-cart failures are reported in the body,
 * which is where an operator looks, rather than by failing the whole run.
 */
export const runtime = "nodejs";
/** A sweep must never be cached — it is a mutation behind a GET. */
export const dynamic = "force-dynamic";
/** One send per cart, batched at 200; ample, and short of a runaway. */
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = authenticateCron(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.code, message: auth.message, resolution: auth.resolution } },
      { status: auth.status },
    );
  }

  const result = await sweepAbandonedCarts();

  return NextResponse.json({
    ok: true,
    ...result,
    /**
     * Says why nothing happened, because "sent: 0" has two very different
     * causes and an operator should not have to guess which. Abandoned-cart
     * mail is **opt-in per storefront** (`sites.abandoned_cart_emails`), so a
     * deployment where no merchant has enabled it will report zero forever, and
     * that is correct rather than broken.
     */
    note:
      result.considered === 0
        ? "No carts matched. Recovery mail is opt-in per storefront — check that a site has it enabled."
        : undefined,
  });
}
