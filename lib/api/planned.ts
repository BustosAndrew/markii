import { ApiClientError } from "./types";

export class PlannedError extends Error {
  /** Internal label for logs only — never show `section` to merchants. */
  section: string;

  constructor(
    section: string,
    message = "This feature isn’t available yet.",
  ) {
    super(message);
    this.name = "PlannedError";
    this.section = section;
  }
}

export function isPlannedError(error: unknown): error is PlannedError {
  return error instanceof PlannedError;
}

export function isEndpointMissing(error: unknown) {
  return error instanceof ApiClientError && (error.status === 404 || error.status === 501);
}

/**
 * A route that exists and is reachable, but cannot do its job because a
 * credential is missing on this deployment — `503 CONFIGURATION_REQUIRED`
 * (`lib/payments/`, `/api/billing/*`, `lib/email/`).
 *
 * Distinct from {@link PlannedError} on purpose. "Not built yet" and "built,
 * waiting on a key" look identical in a generic error toast and are different
 * facts: only one of them has an owner who can act. Merging them is how a
 * surface ends up claiming something is coming when it is actually sitting
 * behind an unset environment variable.
 */
export function isConfigurationRequired(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.code === "CONFIGURATION_REQUIRED";
}

export function toPlannedError(error: unknown, section: string): never {
  if (isPlannedError(error)) {
    throw error;
  }

  if (isEndpointMissing(error)) {
    throw new PlannedError(section);
  }

  throw error;
}

export async function callWhenLive<T>(
  live: boolean,
  section: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!live) {
    throw new PlannedError(section);
  }

  try {
    return await fn();
  } catch (error) {
    toPlannedError(error, section);
  }
}
