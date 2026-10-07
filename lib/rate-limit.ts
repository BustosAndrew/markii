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

/**
 * The REST policy for API tokens (G12) — `Authorization: Bearer mk_…` on any
 * `/api/*` route.
 *
 * **The same credential, limited on the second door.** A token used through
 * `/api/mcp` was capped at `MCP_RATE_LIMIT` while the same token on the REST
 * surface was capped at nothing, so a limit an agent hit on one surface was
 * routable around on the other. Keyed on the token for the same reasons as
 * the MCP policy; cookie sessions are not limited here at all — a dashboard
 * page fans out many calls per render, MFA and the auth limits already gate
 * how a session is obtained, and the caller that loops is one holding a token.
 *
 * **Deliberately above the MCP limit, and the ordering is load-bearing.** The
 * MCP `read_*` tools forward in-process to these same REST handlers carrying
 * the caller's own token (`lib/mcp/reads.ts`), so every MCP read is counted on
 * both keys. Were this ceiling at or below MCP's, an MCP client would be
 * refused by the REST counter before reaching the number `docs/MCP.md`
 * promises it, with a `429` from the wrong surface.
 *
 * Higher for its own reason too: a REST integration is typically a sync — a
 * catalogue pulled page by page, orders polled every minute — where an MCP
 * turn is a handful of calls.
 */
export const API_TOKEN_RATE_LIMIT: RateLimitPolicy = {
  limit: Number(process.env.API_TOKEN_RATE_LIMIT ?? 300),
  windowMs: 60_000,
};

/**
 * A positive integer from the environment, or the default.
 *
 * `Number("abc")` is `NaN`, and a `NaN` limit refuses every request — `count
 * <= NaN` is false — so a typo in an override would turn a throttle into an
 * outage. An override that is not a positive number is ignored, not obeyed.
 */
export function limitFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * Storefront fair use (G12) — every request to one store from one client
 * address, pages and storefront APIs alike.
 *
 * **Throttle, never block.** Storefronts exist to be read by agents, so the
 * answer to a fast crawler is a `429` with a `Retry-After` it can obey, not a
 * ban. The ceiling sits where no person browsing meets it — four requests a
 * second, sustained for a minute — and where a scraper hammering one store
 * from one machine does.
 *
 * **Per store and address, not per agent.** A crawler identifies itself by
 * user agent, which anyone can type: a budget keyed on `GPTBot` could be spent
 * by someone else claiming to be it, and the real crawler would then be turned
 * away from a store it was entitled to read — blocking by proxy. The address
 * is the dimension a caller cannot borrow from someone else. Per store, so a
 * crawler working through many storefronts from one address is not penalised
 * on the hundredth for the ninety-nine before it.
 */
export const STOREFRONT_RATE_LIMIT: RateLimitPolicy = {
  limit: limitFromEnv("STOREFRONT_RATE_LIMIT", 240),
  windowMs: 60_000,
};

/**
 * Download fair use (G12 × G5) — redemptions of one download link per day.
 *
 * **This is the bandwidth control.** A merchant may set no download limit,
 * and a link with none, posted to a forum, would let strangers pull a 2 GB
 * file without end — egress Markii pays for and nothing else bounds. A buyer
 * re-downloading on a second device, or after a failed transfer, uses two or
 * three of these; ten a day is far above that and far below a leak.
 *
 * Time-based, so it **throttles rather than cuts off**: the link works again
 * tomorrow, and a refused attempt is not counted against the merchant's own
 * download limit.
 */
export const DOWNLOAD_RATE_LIMIT: RateLimitPolicy = {
  limit: limitFromEnv("DOWNLOAD_RATE_LIMIT", 10),
  windowMs: 24 * 60 * 60_000,
};
