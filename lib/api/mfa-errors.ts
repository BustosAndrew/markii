export type MfaGate =
  | { status: "ok" }
  | { status: "enroll"; reason: string }
  | { status: "challenge"; factorIds?: string[]; reason: string };

export type MfaErrorDetails = {
  gate: MfaGate;
  stepUpWindowMs?: number;
  action?: string;
};

/**
 * True when a failed request is asking for a factor rather than a sign-in.
 *
 * **Handle this centrally, not per screen.** Treating it as a session failure
 * would sign the merchant out — they would sign back in and land in the same
 * place. That loop is why the API answers `403` here rather than `401`.
 */
export function isMfaRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "MFA_REQUIRED"
  );
}

/** Pull the gate object out of an `MFA_REQUIRED` error's `details`. */
export function mfaErrorDetails(error: unknown): MfaErrorDetails | null {
  if (!isMfaRequired(error)) return null;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const gate = (details as { gate?: unknown }).gate;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
  const status = (gate as { status?: unknown }).status;
  if (status !== "ok" && status !== "enroll" && status !== "challenge") {
    return null;
  }
  return details as MfaErrorDetails;
}

/** Where to send a merchant whose session has not cleared MFA yet. */
export function mfaPathForGate(
  gate: MfaGate,
): "/mfa/enroll" | "/mfa/challenge" | null {
  if (gate.status === "enroll") return "/mfa/enroll";
  if (gate.status === "challenge") return "/mfa/challenge";
  return null;
}
