import { NextResponse } from "next/server";
import { ApiError, handler, unauthorized } from "@/lib/api";
import { gateFor, mfaApplies, readMfaState } from "@/lib/auth/mfa";
import { remainingRecoveryCodes } from "@/lib/auth/recovery-codes";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * `GET /api/auth/mfa` (§16, D40) — where this account stands.
 *
 * The screen that decides whether to show enrolment, a challenge, or settings
 * reads this. It is deliberately callable by a session that has **not** cleared
 * MFA yet — otherwise a merchant at `aal1` could not find out what they need to
 * do next, which is the state every merchant is in immediately after signing in.
 */
export const GET = handler(async () => {
  const supabase = await getSupabaseServerClient();
  if (!supabase) throw new ApiError("INTERNAL", 503, "Authentication is not configured");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw unauthorized();

  /**
   * Shoppers are never subject to MFA (D40). Reported as `required: false`
   * rather than refused — the same endpoint answering honestly for both kinds
   * is better than a 403 a storefront would have to special-case.
   */
  if (!mfaApplies(user)) {
    return NextResponse.json({
      required: false,
      reason: "Two-factor authentication applies to merchant accounts only.",
      enrolled: false,
      verified: false,
      gate: { status: "ok" },
    });
  }

  const state = await readMfaState(supabase);

  return NextResponse.json({
    required: true,
    enrolled: state.enrolled,
    verified: state.verified,
    currentLevel: state.currentLevel,
    gate: gateFor(state),
    /**
     * Surfaced so a merchant can be warned *before* they run out. Someone with
     * one code left and a broken phone is one bad day from a support ticket
     * nobody can resolve without a service-role reset.
     */
    recoveryCodesRemaining: state.enrolled ? await remainingRecoveryCodes(user.id) : 0,
  });
});
