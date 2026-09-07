import { ZodError } from "zod";
import { ApiError } from "../api";
import { sanitizePublicCopy, sanitizePublicValue } from "../api/public-copy";

/**
 * Shaping errors for the MCP wire.
 *
 * **Extracted so the sanitizing is testable.** Inline in the route it could only
 * be checked by an integration test asserting that a real response *happens not*
 * to contain a secret — which passes just as well when nothing was sanitized and
 * nothing happened to leak. Here a deliberately leaky error can be pushed
 * through and the stripping observed.
 *
 * The rule is `lib/api/public-copy.ts`, whose own docstring covers anything
 * shown to "merchants, shoppers, **or agents**" — so it always applied here.
 * `errorResponse` has honoured it on every HTTP reply since the beginning; this
 * route did not, and passed `ApiError.message` through untouched while echoing
 * raw exception text on the internal path.
 */

/** What a refused tool call reports back, as a tool result rather than a protocol error. */
export function toolErrorPayload(e: unknown): string {
  if (e instanceof ApiError) {
    return JSON.stringify(
      {
        code: e.code,
        message: sanitizePublicCopy(e.message),
        details: sanitizePublicValue(e.details),
      },
      null,
      2,
    );
  }

  if (e instanceof ZodError) {
    /**
     * Bad arguments are the most common thing a model gets wrong, and reporting
     * it as a transport fault hides the field name it needs to recover.
     */
    return JSON.stringify(
      {
        code: "VALIDATION_ERROR",
        message: "The arguments did not match this tool's input schema.",
        issues: e.issues.map((i) => ({
          field: i.path.join(".") || "(root)",
          message: sanitizePublicCopy(i.message),
        })),
      },
      null,
      2,
    );
  }

  return null as never;
}

/** True when `toolErrorPayload` can describe this error to an agent usefully. */
export function isReportableToolError(e: unknown): boolean {
  return e instanceof ApiError || e instanceof ZodError;
}

/**
 * The message and data for a JSON-RPC error.
 *
 * **An unrecognised error yields no detail at all.** A driver error carries
 * table and column names and a config error can carry an env var name; both are
 * for logs. `errorResponse` says the same thing — "never echo raw exception
 * text — stacks and driver errors are for logs only".
 */
export function rpcErrorPayload(e: unknown): {
  message: string;
  data?: { code: string; details: unknown };
} {
  if (e instanceof ApiError) {
    return {
      message: sanitizePublicCopy(e.message),
      data: { code: e.code, details: sanitizePublicValue(e.details) },
    };
  }
  return { message: "Something went wrong." };
}
