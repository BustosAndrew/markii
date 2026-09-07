/**
 * Fixed-window rate limiting.
 *
 * The pure half: given a window and a count, decide. The database half is in
 * `./rate-limit-store`, split for the reason `standing` is split from
 * `standing-guard` — the arithmetic is what is worth testing, and it must not
 * drag a database into every test that touches it.
 *
 * **Fixed window, not a sliding one**, and the trade is worth stating: a caller
 * can send `limit` requests at the very end of one window and `limit` again at
 * the start of the next, so the true worst case over a short span is twice the
 * nominal rate. A sliding window would need per-request timestamps rather than
 * a counter — more rows, more work, on every request. Doubling the burst
 * ceiling is the cheaper thing to be wrong about than adding a write amplifier
 * to the hot path.
 */

export type RateLimitPolicy = {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  /** Requests left in this window, floored at 0. */
  remaining: number;
  /** When the current window ends. */
  resetAt: Date;
  /** Whole seconds until reset, at least 1 — a `Retry-After` of 0 invites a hot loop. */
  retryAfterSeconds: number;
};

/**
 * The window a moment belongs to.
 *
 * Aligned to the epoch rather than to first contact, so every caller's window
 * boundary is the same instant. Windows anchored per-caller drift apart and
 * make a burst impossible to reason about across callers.
 */
export function windowStartFor(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Decide, given the count already recorded **including** the current request.
 *
 * The store increments first and asks afterwards, so a count equal to the limit
 * is the last permitted request rather than the first refused one.
 */
export function decide(
  countIncludingThis: number,
  windowStart: Date,
  policy: RateLimitPolicy,
): RateLimitDecision {
  const resetAt = new Date(windowStart.getTime() + policy.windowMs);
  const remaining = Math.max(0, policy.limit - countIncludingThis);

  return {
    allowed: countIncludingThis <= policy.limit,
    remaining,
    resetAt,
    /**
     * Rounded **up**, and never below one second. A caller told to retry in
     * zero seconds retries immediately, which is the behaviour the limit
     * exists to stop.
     */
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)),
  };
}

/** The headers a well-behaved client backs off on. */
export function rateLimitHeaders(
  decision: RateLimitDecision,
  policy: RateLimitPolicy,
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(policy.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(decision.retryAfterSeconds),
  };
  // `Retry-After` only when refused: on a successful reply it reads as an
  // instruction to wait, which is not what is being said.
  if (!decision.allowed) headers["Retry-After"] = String(decision.retryAfterSeconds);
  return headers;
}

/**
 * The MCP policy.
 *
 * **Per token, not per IP.** MCP is token-authenticated, an IP is shared behind
 * NAT and forgeable without a trusted proxy, and the credential is the thing
 * that can actually be revoked. It also means one merchant's runaway agent
 * cannot exhaust another's allowance.
 *
 * The default is set where an agent working normally will not notice it — a
 * turn that reads a catalog, reads an order and writes twice is a handful of
 * calls — while a loop that has lost its footing hits it in seconds.
 */
export const MCP_RATE_LIMIT: RateLimitPolicy = {
  limit: Number(process.env.MCP_RATE_LIMIT ?? 120),
  windowMs: 60_000,
};
