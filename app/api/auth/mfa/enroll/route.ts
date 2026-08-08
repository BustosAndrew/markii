import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, badRequest, conflict, handler, unauthorized } from "@/lib/api";
import { mfaApplies, readMfaState } from "@/lib/auth/mfa";
import { issueRecoveryCodes } from "@/lib/auth/recovery-codes";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * `POST /api/auth/mfa/enroll` (§16, D40) — begin adding a factor.
 * `PUT` — finish it by proving the merchant can produce a code.
 *
 * Two steps, because **an unverified factor protects nothing and can lock
 * someone out.** Supabase creates a factor the moment enrolment starts; if that
 * counted as enrolled, a merchant who opened the setup screen and closed the tab
 * would be challenged at their next sign-in for an authenticator they never
 * finished adding. `readMfaState` therefore only counts `verified` factors, and
 * this route only issues recovery codes once a real code has been presented.
 *
 * **Card-style secrecy applies to the TOTP secret**: it is returned exactly once,
 * on `POST`, and is never readable afterwards. Recovery codes likewise, on `PUT`.
 */

export const POST = handler(async () => {
  const supabase = await getSupabaseServerClient();
  if (!supabase) throw new ApiError("INTERNAL", 503, "Authentication is not configured");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw unauthorized();
  if (!mfaApplies(user)) {
    throw conflict("Two-factor authentication applies to merchant accounts only.");
  }

  const state = await readMfaState(supabase);
  if (state.enrolled) {
    /**
     * Already protected. Refused rather than silently adding a second factor —
     * a merchant who lands here twice should be told they are done, not handed
     * a fresh secret that makes their existing authenticator look broken.
     */
    throw conflict("This account already has two-factor authentication enabled.");
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `markii-${Date.now()}`,
  });
  if (error || !data) {
    throw new ApiError("INTERNAL", 502, error?.message ?? "Could not start enrolment");
  }

  return NextResponse.json({
    factorId: data.id,
    /**
     * Shown once and never retrievable. `uri` is what an authenticator app
     * scans; `secret` is the manual-entry fallback for someone whose camera
     * does not work — which is exactly the person who most needs a way in.
     */
    secret: data.totp.secret,
    uri: data.totp.uri,
    qrCode: data.totp.qr_code,
    note: "Scan this, then confirm a code to finish. It cannot be shown again.",
  });
});

const confirmSchema = z.object({
  factorId: z.string().min(1).max(200),
  code: z.string().min(6).max(10),
});

export const PUT = handler(async (req) => {
  const supabase = await getSupabaseServerClient();
  if (!supabase) throw new ApiError("INTERNAL", 503, "Authentication is not configured");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw unauthorized();
  if (!mfaApplies(user)) {
    throw conflict("Two-factor authentication applies to merchant accounts only.");
  }

  const input = confirmSchema.parse(await req.json());

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: input.factorId,
  });
  if (challengeError || !challenge) {
    throw badRequest(challengeError?.message ?? "Could not start the challenge");
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: input.factorId,
    challengeId: challenge.id,
    code: input.code,
  });
  if (verifyError) {
    // Supabase's own wording — "Invalid TOTP code entered" is actionable, and a
    // wrong code is the ordinary case here, not an error worth dressing up.
    throw badRequest(verifyError.message);
  }

  /**
   * **Issued only now**, after a code has actually been produced. Handing them
   * out at `POST` would mean an abandoned enrolment left a set of live bypass
   * credentials on an account with no working factor behind them.
   *
   * This also replaces any previous set, which matters for the re-enrolment
   * path: codes from an authenticator the merchant no longer has must not keep
   * working.
   */
  const recoveryCodes = await issueRecoveryCodes(user.id);

  return NextResponse.json({
    enrolled: true,
    /**
     * The only time these are ever visible. Stored as salted hashes, so there is
     * no path that can show them again — a screen that does not make the
     * merchant save them now has failed them.
     */
    recoveryCodes,
    note:
      "Save these recovery codes somewhere safe. They are the only way back into your account " +
      "if you lose your authenticator, and they cannot be shown again.",
  });
});
