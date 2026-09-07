import { ApiClientError } from "./types";

/**
 * The free month lapsed and nothing was bought (`docs/API.md` §17, D45).
 *
 * **Not an auth failure.** The caller's permissions are fine and a second
 * factor changes nothing — what is missing is a plan. Treating this as
 * `MFA_REQUIRED` would open the step-up modal in front of a subscribe button.
 */
export function isTrialEnded(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.status === 402 &&
    error.code === "TRIAL_ENDED"
  );
}
