import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { isStaffUser } from "./user-kind";

/**
 * Multi-factor authentication for merchants (D40).
 *
 * **Mandatory for every staff account, never for shoppers.** Staff and
 * storefront customers share one Supabase project (D32), so every decision here
 * keys on `user_kind` — forcing a second factor on a shopper would wreck
 * merchants' conversion, and guest checkout would make it bypassable anyway.
 *
 * **Everything runs server-side.** Supabase's own docs drive `auth.mfa.*` from a
 * browser client, which D30 forbids outright: a cookie written from
 * `document.cookie` cannot be `HttpOnly`, and merchant custom code runs on
 * storefronts. So the TOTP secret and the QR payload travel through Markii's own
 * routes, and `lib/supabase/client.ts` does not exist in this tree.
 *
 * The distinction that carries the security is **`aal2`, not enrolment**.
 * Supabase leaves a session at `aal1` until it is challenged, so treating "has a
 * factor" as protected would be decoration — an attacker with a stolen password
 * would hold a perfectly valid `aal1` session on an account that looks
 * MFA-protected.
 */

/** Supabase's assurance levels. `aal2` means a factor was actually presented. */
export type AssuranceLevel = "aal1" | "aal2";

export type MfaState = {
  /** A factor exists and is confirmed. */
  enrolled: boolean;
  /** The session has actually satisfied it. */
  verified: boolean;
  currentLevel: AssuranceLevel | null;
  /** What Supabase says this session *should* reach — `aal2` once enrolled. */
  nextLevel: AssuranceLevel | null;
  /** Confirmed factor ids, for challenge. Unverified enrolments are excluded. */
  factorIds: string[];
};

/**
 * Whether this account is subject to MFA at all.
 *
 * The **only** place the staff/shopper split is decided for MFA. Every caller
 * routes through it rather than re-testing `user_kind`, so there is one answer
 * and it cannot drift between the enrolment gate and the enforcement gate.
 */
export function mfaApplies(user: User | null): boolean {
  return Boolean(user) && isStaffUser(user as User);
}

/**
 * Reads the session's factor and assurance state.
 *
 * Only **verified** factors count as enrolment. Supabase creates a factor in an
 * `unverified` state the moment enrolment starts, so counting those would mark
 * an account protected because someone opened the setup screen and walked away —
 * and then lock them out of their own store at the next sign-in with a factor
 * they never finished adding.
 */
export async function readMfaState(supabase: SupabaseClient): Promise<MfaState> {
  const [{ data: factors }, { data: aal }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);

  const verifiedFactors = (factors?.totp ?? []).filter((f) => f.status === "verified");
  const currentLevel = (aal?.currentLevel as AssuranceLevel | null) ?? null;

  return {
    enrolled: verifiedFactors.length > 0,
    verified: currentLevel === "aal2",
    currentLevel,
    nextLevel: (aal?.nextLevel as AssuranceLevel | null) ?? null,
    factorIds: verifiedFactors.map((f) => f.id),
  };
}

/**
 * What a merchant must do before they are allowed anywhere.
 *
 * Three states, kept apart because they send a person to three different places
 * and collapsing them into "unauthorized" would strand someone mid-enrolment
 * with no way forward:
 *
 * - `ok` — nothing to do.
 * - `enroll` — signed in, no factor. Send them to set one up.
 * - `challenge` — factor exists, session is still `aal1`. Ask for the code.
 */
export type MfaGate =
  | { status: "ok" }
  | { status: "enroll"; reason: string }
  | { status: "challenge"; factorIds: string[]; reason: string };

export function gateFor(state: MfaState): MfaGate {
  if (!state.enrolled) {
    return {
      status: "enroll",
      reason: "Two-factor authentication is required for merchant accounts.",
    };
  }
  if (!state.verified) {
    return {
      status: "challenge",
      factorIds: state.factorIds,
      reason: "Enter the code from your authenticator app.",
    };
  }
  return { status: "ok" };
}

/**
 * Whether a session is fresh enough to make a sensitive change (D40 step-up).
 *
 * Being at `aal2` is not the same as having *just* proved it. A session that
 * cleared MFA this morning is still `aal2` this evening, and treating that as
 * consent to move a merchant's payout address is exactly the gap step-up exists
 * to close — the laptop left open in a co-working space is the threat, not a
 * cracked password.
 *
 * Fifteen minutes: long enough to complete a settings flow without re-typing a
 * code at every step, short enough that an unattended session is not a standing
 * authorisation.
 */
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

/**
 * Supabase stamps `amr` (authentication methods reference) into the JWT with a
 * timestamp per method. The **most recent** MFA entry is when the second factor
 * was last actually presented — which is the only thing that can answer "was
 * this person here just now?".
 */
export function lastFactorAt(amr: { method: string; timestamp: number }[] | undefined): Date | null {
  const mfaEntries = (amr ?? []).filter((e) => e.method === "totp" || e.method === "mfa/totp");
  if (mfaEntries.length === 0) return null;
  const latest = Math.max(...mfaEntries.map((e) => e.timestamp));
  return Number.isFinite(latest) ? new Date(latest * 1000) : null;
}

export function stepUpSatisfied(
  amr: { method: string; timestamp: number }[] | undefined,
  now: Date = new Date(),
): boolean {
  const at = lastFactorAt(amr);
  if (!at) return false;
  return now.getTime() - at.getTime() <= STEP_UP_WINDOW_MS;
}

/**
 * The enforcement point (D40). Throws unless this session has satisfied MFA.
 *
 * Called from `requireAuthContext` on the **session** path only — API tokens are
 * their own credential, minted by an already-protected session, and refusing
 * them would break every integration without protecting anything a token holder
 * could not already do.
 *
 * `MFA_REQUIRED` rather than `UNAUTHORIZED`, because the caller *is*
 * authenticated. A 401 would send a merchant back to a sign-in form that cannot
 * fix the problem — they would sign in successfully and land in the same place.
 * The `gate` says which of the two things to actually do.
 */
export async function assertMfaSatisfied(): Promise<void> {
  const { getSupabaseServerClient } = await import("../supabase/server");
  const { ApiError } = await import("../api");

  const supabase = await getSupabaseServerClient();
  if (!supabase) return;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  /**
   * No user, or a shopper: nothing to enforce. The caller has already
   * established a staff session by this point, so this is a guard against the
   * function being reused somewhere it was not designed for, not a live path.
   */
  if (!mfaApplies(user)) return;

  const gate = gateFor(await readMfaState(supabase));
  if (gate.status === "ok") return;

  throw new ApiError("MFA_REQUIRED", 403, gate.reason, { gate });
}

/**
 * Step-up enforcement for the action registry (D40).
 *
 * **Only human sessions are challenged.** A `token` actor never had a factor to
 * present and never will — it is a credential in its own right, revoked rather
 * than re-authenticated. A `system` actor is a migration or a seed with no
 * browser at all. Demanding a factor from either would not make them safer; it
 * would make them impossible, and the pressure would then be to drop the
 * requirement from the action instead.
 *
 * An `agent` actor **is** challenged, through the human it acts for: §22 exists
 * so an agent gets no privileged path, and "the assistant did it" is not a
 * reason to skip proving a person is present for a payout change.
 */
export async function assertStepUp(
  actor: { type: "user" | "agent" | "token" | "system" },
  actionId: string,
): Promise<void> {
  if (actor.type === "token" || actor.type === "system") return;

  const { getSupabaseServerClient } = await import("../supabase/server");
  const { ApiError } = await import("../api");

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new ApiError("MFA_REQUIRED", 403, "This change needs re-authentication.", {
      gate: { status: "challenge", reason: "Authentication is unavailable." },
    });
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  /**
   * `amr` carries a timestamp per authentication method, so the most recent MFA
   * entry answers "was this person here just now?" — which `aal2` alone cannot.
   * A session that cleared MFA this morning is still `aal2` this evening, and
   * treating that as consent to move a payout address is the gap step-up closes.
   */
  const amr = (session as { user?: { amr?: { method: string; timestamp: number }[] } } | null)?.user
    ?.amr;

  if (stepUpSatisfied(amr)) return;

  throw new ApiError(
    "MFA_REQUIRED",
    403,
    "Confirm it is you before making this change.",
    {
      gate: {
        status: "challenge",
        reason: `"${actionId}" changes payments, access, or credentials.`,
      },
      /** So a client knows how long a fresh challenge buys before re-prompting. */
      stepUpWindowMs: STEP_UP_WINDOW_MS,
      action: actionId,
    },
  );
}
