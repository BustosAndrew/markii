import { apiGet, apiPost, apiPut } from "./client";

/**
 * Merchant MFA (§16, D40).
 *
 * **Not gated behind a `*_API_LIVE` constant.** Every one of these routes is
 * real, and gating them would make the screens show "coming soon" while the
 * backend refuses every other request — leaving a merchant signed in and unable
 * to reach anything, with no explanation on screen.
 *
 * Shoppers are never subject to any of this.
 */

export type MfaGate =
  | { status: "ok" }
  | { status: "enroll"; reason: string }
  | { status: "challenge"; factorIds?: string[]; reason: string };

export type MfaStatus = {
  /** False for a storefront shopper — the same endpoint answers for both kinds. */
  required: boolean;
  enrolled: boolean;
  verified: boolean;
  currentLevel: "aal1" | "aal2" | null;
  gate: MfaGate;
  /** Warn before this hits zero: no codes and a lost phone is unrecoverable. */
  recoveryCodesRemaining: number;
};

/**
 * **Reachable before MFA is satisfied**, unlike every other authenticated route.
 * It is how a gated merchant finds out what to do, so it must not itself be
 * gated — call it immediately after sign-in and branch on `gate.status`.
 */
export function getMfaStatus(init?: RequestInit) {
  return apiGet<MfaStatus>("/api/auth/mfa", undefined, init);
}

export type MfaEnrolStart = {
  factorId: string;
  /** Manual-entry fallback. **Shown once** — there is no way to fetch it again. */
  secret: string;
  /** `otpauth://` — render this as the QR code. */
  uri: string;
  qrCode: string;
  note: string;
};

export function startMfaEnrolment(init?: RequestInit) {
  return apiPost<MfaEnrolStart>("/api/auth/mfa/enroll", undefined, init);
}

export type MfaEnrolComplete = {
  enrolled: true;
  /**
   * **The only time these are ever visible.** Stored as salted hashes, so no
   * endpoint can return them again. A screen that lets a merchant move on
   * without saving them has failed them — this is the sole way back from a lost
   * authenticator.
   */
  recoveryCodes: string[];
  note: string;
};

export function completeMfaEnrolment(
  body: { factorId: string; code: string },
  init?: RequestInit,
) {
  return apiPut<MfaEnrolComplete>("/api/auth/mfa/enroll", body, init);
}

/**
 * Takes the session from `aal1` to `aal2`.
 *
 * **Also the step-up endpoint.** When a money-moving action returns
 * `MFA_REQUIRED`, call this and then retry the original request — a modal, not a
 * redirect, so the merchant does not lose what they were doing.
 */
export function verifyMfaCode(body: { code: string; factorId?: string }, init?: RequestInit) {
  return apiPost<{ verified: true; note: string }>("/api/auth/mfa/challenge", body, init);
}

export type MfaRecovery = {
  recovered: true;
  /** Always true — recovery grants the ability to enrol again, not access. */
  mustEnroll: true;
  recoveryCodesRemaining: number;
  note: string;
};

/**
 * Spend a recovery code. Removes the authenticator and sends the merchant back
 * to enrolment — **not** to the dashboard, which stays locked until a new factor
 * exists. Removing the last factor may also invalidate the session, so handle a
 * `401` by routing to sign-in.
 */
export function recoverMfa(body: { code: string }, init?: RequestInit) {
  return apiPost<MfaRecovery>("/api/auth/mfa/recover", body, init);
}

/**
 * True when a failed request is asking for a factor rather than a sign-in.
 *
 * **Handle this centrally, not per screen.** Any authenticated call can return
 * it, and treating it as a session failure would sign the merchant out — which
 * fixes nothing, because they would sign back in and land in the same place.
 * That loop is exactly why the API answers `403` here rather than `401`.
 */
export function isMfaRequired(error: unknown): error is {
  code: "MFA_REQUIRED";
  message: string;
  details: { gate: MfaGate; stepUpWindowMs?: number; action?: string };
} {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "MFA_REQUIRED"
  );
}
