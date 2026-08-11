import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { Actor } from "../actions/types";

/**
 * The trust boundary for scheduled work.
 *
 * **This module exists because of one sentence that used to be true.** Both
 * `system`-actor bypasses — `authorize()` returning `true` without consulting a
 * role, and `assertStepUp()` returning without demanding a factor — were
 * justified by the comment "never reachable over HTTP". A cron job on Vercel is
 * an HTTPS request and nothing else, so introducing one makes that sentence
 * false and turns both bypasses into a hole unless something else carries the
 * weight they were resting on.
 *
 * `CRON_SECRET` is that something. It is the *only* credential in this codebase
 * that mints a `system` actor from a request, which is why the check lives here
 * on its own rather than inline in the route: there is one place to audit, and
 * `mintSystemActor` is deliberately not exported separately from the check that
 * guards it.
 *
 * The three rules below are each load-bearing:
 *
 *  1. **A missing secret refuses.** Not "allows in development", not "warns" —
 *     an unset variable making the endpoint public would hand any caller on the
 *     internet an actor that authorizes every permission and skips step-up.
 *     That is the single worst default available here, and it is the one a
 *     `?? ""` would silently produce.
 *  2. **Constant-time comparison.** The endpoint is unauthenticated by
 *     definition and can be probed as often as an attacker likes, which is
 *     exactly the condition a byte-by-byte `===` leaks a secret under.
 *  3. **A short secret refuses.** A guessable `CRON_SECRET` is not meaningfully
 *     different from none, and this is the last point at which anyone would
 *     notice.
 */

/** Long enough that guessing is not a strategy. 32 chars ≈ `openssl rand -hex 16`. */
const MIN_SECRET_LENGTH = 32;

export type CronAuthResult =
  | { ok: true; actor: Actor }
  | { ok: false; status: 401 | 503; code: string; message: string; resolution?: string };

/**
 * Compares without leaking length or position.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a timing
 * signal, so both sides are hashed to a fixed width first. Comparing the digests
 * is equivalent to comparing the inputs and is the standard way to make the
 * length safe to handle.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Reads the bearer token Vercel Cron sends.
 *
 * Vercel invokes cron endpoints with `Authorization: Bearer $CRON_SECRET`. The
 * header is the only accepted carrier — a query parameter would end up in access
 * logs, browser history, and any referrer that leaves the origin.
 */
function presentedSecret(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Authenticates a scheduled invocation and mints the actor it runs as.
 *
 * The returned actor has `orgId: null` — the sweep sets the org per invocation,
 * because one cron run touches many organizations and an actor carrying the
 * wrong one would attribute an audit row to a merchant who was not involved.
 */
export function authenticateCron(request: Request): CronAuthResult {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    return {
      ok: false,
      /**
       * 503, not 401. The caller presented nothing wrong; this deployment is not
       * configured to run scheduled work, and an operator reading the log needs
       * to know the difference between "someone probed the endpoint" and "the
       * billing cron has never once been able to run".
       */
      status: 503,
      code: "CONFIGURATION_REQUIRED",
      message: "Scheduled billing is not configured on this deployment.",
      resolution:
        "Set CRON_SECRET to a random value of at least " +
        `${MIN_SECRET_LENGTH} characters and redeploy. Until then no period is closed and no ` +
        "threshold fee is invoiced.",
    };
  }

  if (expected.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      status: 503,
      code: "CONFIGURATION_REQUIRED",
      message: `CRON_SECRET is shorter than ${MIN_SECRET_LENGTH} characters.`,
      resolution:
        "This endpoint mints an actor that bypasses permission checks and step-up, so a " +
        "guessable secret is equivalent to no secret. Generate one with `openssl rand -hex 32`.",
    };
  }

  const presented = presentedSecret(request);
  if (!presented || !secretsMatch(presented, expected)) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      /** Says nothing about which half was wrong, or whether the secret exists. */
      message: "Unauthorized.",
    };
  }

  return {
    ok: true,
    actor: { type: "system", id: "cron:billing", orgId: null },
  };
}
