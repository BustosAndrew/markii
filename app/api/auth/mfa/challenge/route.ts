import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, badRequest, conflict, handler, unauthorized } from "@/lib/api";
import { mfaApplies, readMfaState } from "@/lib/auth/mfa";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * `POST /api/auth/mfa/challenge` (§16, D40) — take the session from `aal1` to
 * `aal2`.
 *
 * This is the step that makes MFA real. Enrolment alone changes nothing: a
 * session stays at `aal1` until a factor is actually presented, so an attacker
 * holding a stolen password would otherwise sit on a perfectly valid session of
 * an account that *looks* protected.
 *
 * **It is also the step-up endpoint.** D40 requires a *fresh* factor before
 * sensitive changes — moving the x402 wallet address, inviting staff, minting an
 * API token — and re-running this stamps a new `amr` timestamp, which is what
 * `stepUpSatisfied` reads. One endpoint for both because they are the same act:
 * prove you are still here.
 */

const schema = z.object({
  /** Optional — with one factor, which to challenge is not a real question. */
  factorId: z.string().min(1).max(200).optional(),
  code: z.string().min(6).max(10),
});

export const POST = handler(async (req) => {
  const supabase = await getSupabaseServerClient();
  if (!supabase) throw new ApiError("INTERNAL", 503, "Authentication is not configured");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw unauthorized();
  if (!mfaApplies(user)) {
    throw conflict("Two-factor authentication applies to merchant accounts only.");
  }

  const input = schema.parse(await req.json());
  const state = await readMfaState(supabase);

  if (!state.enrolled) {
    /**
     * Nothing to challenge. Distinguished from a bad code so a merchant is sent
     * to enrolment rather than made to hunt for an authenticator entry that does
     * not exist.
     */
    throw conflict("This account has no authenticator set up yet.");
  }

  const factorId = input.factorId ?? state.factorIds[0];
  if (!state.factorIds.includes(factorId)) {
    // Only this user's own confirmed factors, never an id from the request.
    throw badRequest("Unknown authenticator for this account.");
  }

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
  if (challengeError || !challenge) {
    throw badRequest(challengeError?.message ?? "Could not start the challenge");
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code: input.code,
  });
  if (verifyError) {
    /**
     * Deliberately not counted or rate-limited here — Supabase applies its own
     * limits to `verify`, and a second counter in Markii would drift from the
     * one actually doing the refusing and lock people out on a different
     * schedule than the errors they were shown.
     */
    throw badRequest(verifyError.message);
  }

  return NextResponse.json({
    verified: true,
    /**
     * The session cookie has been rewritten at `aal2` by the `setAll` adapter,
     * so no token is returned here — nothing for a client to hold, which is the
     * whole point of the httpOnly rule (D30).
     */
    note: "Verified.",
  });
});
