import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, badRequest, conflict, handler, unauthorized } from "@/lib/api";
import { mfaApplies, readMfaState } from "@/lib/auth/mfa";
import { consumeRecoveryCode, remainingRecoveryCodes } from "@/lib/auth/recovery-codes";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * `POST /api/auth/mfa/recover` (§16, D40) — the way back in when the
 * authenticator is gone.
 *
 * **This is the endpoint that decides whether "mandatory MFA" is a security
 * control or a way to destroy merchants' businesses.** A lost phone is not an
 * edge case at any real volume, and without this the only path back is a
 * hand-run service-role reset — which is a support queue with someone's
 * livelihood sitting in it.
 *
 * **A valid code removes the factor; it does not grant `aal2`.** Supabase will
 * not mint an `aal2` session from anything but a real factor, and faking one is
 * not on offer. So the honest thing is to drop the merchant back to a state they
 * can act on: the factor is unenrolled, the session returns to plain `aal1`, and
 * the enrolment gate then sends them to set up a new authenticator immediately.
 * They are never left signed in and unprotected — `gateFor` refuses everything
 * with `status: "enroll"` until a new factor exists.
 *
 * That ordering matters. Removing the factor *before* re-enrolment is what makes
 * recovery possible at all; requiring the new factor first would need the old one.
 */

const schema = z.object({ code: z.string().min(1).max(40) });

export const POST = handler(async (req) => {
  const supabase = await getSupabaseServerClient();
  if (!supabase) throw new ApiError("INTERNAL", 503, "Authentication is not configured");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  /**
   * A password is still required to get here — recovery replaces the *second*
   * factor, never the first. A code alone must never be a credential, or the
   * printed sheet becomes a master key.
   */
  if (!user) throw unauthorized();
  if (!mfaApplies(user)) {
    throw conflict("Two-factor authentication applies to merchant accounts only.");
  }

  const input = schema.parse(await req.json());
  const state = await readMfaState(supabase);
  if (!state.enrolled) {
    throw conflict("This account has no authenticator to recover from.");
  }

  const spent = await consumeRecoveryCode(user.id, input.code);
  if (!spent.ok) {
    /**
     * One message shape for "wrong", "already used", and "none left" — the same
     * reasoning as sign-in's single failure message. Distinguishing them tells
     * someone guessing which codes have already been burned.
     */
    throw badRequest("That recovery code is not valid.");
  }

  /**
   * Remove **every** confirmed factor, not just one. A merchant recovering has
   * lost the device; leaving a second factor from the same lost phone behind
   * would put them straight back into a challenge they cannot answer.
   */
  const failures: string[] = [];
  for (const factorId of state.factorIds) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) failures.push(error.message);
  }

  if (failures.length > 0) {
    /**
     * The code is already spent and cannot be handed back — reissuing it would
     * mean a used code works twice. So this reports the partial state honestly
     * rather than pretending recovery worked; the merchant has other codes, and
     * the alternative is a silent half-recovery they discover at the next
     * sign-in.
     */
    throw new ApiError(
      "INTERNAL",
      502,
      "The recovery code was accepted but the authenticator could not be removed. " +
        "Try again with another code.",
      { details: failures },
    );
  }

  return NextResponse.json({
    recovered: true,
    /**
     * Stated so the client sends them to enrolment rather than the dashboard.
     * The session is authenticated but **not** protected, and every merchant
     * route refuses until a new factor exists.
     */
    mustEnroll: true,
    recoveryCodesRemaining: await remainingRecoveryCodes(user.id),
    note:
      "Your authenticator has been removed. Set up a new one now — your account is not protected " +
      "until you do, and the rest of the dashboard stays locked until then.",
  });
});
