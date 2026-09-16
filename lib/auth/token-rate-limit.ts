import "server-only";

import { ApiError } from "@/lib/api";
import {
  API_TOKEN_RATE_LIMIT,
  rateLimitHeaders,
  type RateLimitDecision,
  type RateLimitPolicy,
} from "@/lib/rate-limit";
import { consumeRateLimit } from "@/lib/rate-limit-store";
import type { AuthContext } from "./session";

/**
 * The per-token budget on the REST surface (G12).
 *
 * Lives beside the auth limits rather than in `orgHandler` so the handler
 * stays the place that composes checks and this stays the place that explains
 * one. `orgHandler` is the only caller, and that is the point: every route a
 * token can authenticate to is wrapped by it, so a route added tomorrow is
 * limited without opting in — the same choke-point argument that put the
 * request context in `requireAuthContext`.
 */

export type TokenBudget = {
  decision: RateLimitDecision;
  policy: RateLimitPolicy;
};

export function tokenLimitKey(tokenId: string): string {
  return `api:${tokenId}`;
}

/**
 * Count this request against the token and say what is left, or throw.
 *
 * **Only for token callers.** A cookie session returns null — nothing is
 * counted and no headers are added — because a dashboard render fans out a
 * dozen calls at once and any ceiling low enough to catch a script would
 * catch a merchant with two tabs open first. The auth limits and MFA gate how a
 * session comes to exist; what loops is a token.
 *
 * **After authentication**, like the MCP limiter: an anonymous flood is refused
 * a line earlier and cannot fill the counter table with keys nobody owns.
 *
 * **Fails open** through `consumeRateLimit`, and for the same reason it does
 * there — this is an abuse control, and the permission check, the approval
 * gate and the audit log are what actually stand between a caller and the
 * data.
 */
export async function consumeTokenBudget(session: AuthContext): Promise<TokenBudget | null> {
  if (!session.token) return null;

  const policy = API_TOKEN_RATE_LIMIT;
  const decision = await consumeRateLimit(tokenLimitKey(session.token.id), policy);
  if (!decision.allowed) {
    throw new ApiError(
      "RATE_LIMITED",
      429,
      `Rate limit exceeded: ${policy.limit} requests per minute for this token. ` +
        `Retry in ${decision.retryAfterSeconds}s.`,
      { retryAfterSeconds: decision.retryAfterSeconds },
      rateLimitHeaders(decision, policy),
    );
  }
  return { decision, policy };
}

/**
 * Stamp the remaining budget onto a reply.
 *
 * On every reply, not only the refusal — a client that can see
 * `RateLimit-Remaining` falling can slow down before it is turned away, which
 * is the entire point of publishing it. That includes error replies: a `404`
 * spent a request too.
 *
 * A handler may return a `Response` whose headers are immutable (one built
 * from another response, or a redirect), so a copy is made when a set fails
 * rather than letting a header nobody depends on 500 the route.
 */
export function withTokenBudget(res: Response, budget: TokenBudget | null): Response {
  if (!budget) return res;
  const headers = rateLimitHeaders(budget.decision, budget.policy);
  try {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  } catch {
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
  }
}
