import { requestContextFrom } from "@/lib/auth/request-context";
import { STOREFRONT_RATE_LIMIT, rateLimitHeaders, type RateLimitDecision } from "@/lib/rate-limit";
import { consumeRateLimit } from "@/lib/rate-limit-store";
import { storefrontLimitKey, throttledStorefrontBody } from "./fair-use";

/**
 * Storefront fair use (G12) — the proxy's half.
 *
 * **In the proxy, because nowhere else can say 429.** An App Router page cannot
 * set its own status, so a throttle inside the storefront pages could only
 * render an error page with a `200` — which tells a crawler the page is an
 * error page, the opposite of asking it to come back later.
 *
 * **Counted in the background, refused from memory.** Awaiting the counter
 * would put a database round trip in front of every storefront request, on a
 * path that was made query-free on purpose (`lib/domains` caches the custom
 * domain lookup for exactly this reason). So the count is written after the
 * response through `waitUntil`, and when it comes back refused, this instance
 * remembers the key as throttled until its window resets. Every later request
 * from that address to that store is then refused here with no database call.
 *
 * The trade is a lag, and it is the cheap side to be wrong on: on each
 * instance, the request that crosses the limit — and any already in flight —
 * still get through. A scraper is slowed a request late; a shopper never waits
 * on a counter.
 *
 * **The memory is a cache, not the count.** The count lives in
 * `rate_limit_counters`, shared by every instance. An instance that never saw
 * the refusal simply learns it on its own next request. Fails open throughout
 * (`consumeRateLimit`): nothing about a public page depends on this for its
 * safety.
 */

/** Key → epoch ms the throttle lifts. Per instance. */
const throttledUntil = new Map<string, number>();

/**
 * Bounds the map. A flood of distinct addresses is exactly when it would grow,
 * so expired entries are dropped once it is large — never on every request.
 */
const PRUNE_AT = 10_000;

function prune(now: number) {
  if (throttledUntil.size < PRUNE_AT) return;
  for (const [key, until] of throttledUntil) if (until <= now) throttledUntil.delete(key);
}

function refusal(until: number, now: number): Response {
  const decision: RateLimitDecision = {
    allowed: false,
    remaining: 0,
    resetAt: new Date(until),
    retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)),
  };
  return new Response(throttledStorefrontBody(decision.retryAfterSeconds), {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // A cached 429 would throttle callers who never sent a request.
      "cache-control": "no-store",
      ...rateLimitHeaders(decision, STOREFRONT_RATE_LIMIT),
    },
  });
}

/**
 * Count a storefront request and, if this address is known to be over its
 * share of this store, answer for the store with a `429`. Null lets it through.
 *
 * **No address, no throttle.** Behind Vercel the forwarded address is always
 * present; on a bare origin it is not, and pooling every addressless caller
 * into one bucket would throttle the whole world together.
 */
export function throttleStorefront(
  req: Request,
  slug: string,
  waitUntil: (work: Promise<unknown>) => void,
): Response | null {
  const { ip } = requestContextFrom(req);
  if (!ip) return null;

  const key = storefrontLimitKey(slug, ip);
  const now = Date.now();

  const until = throttledUntil.get(key);
  if (until !== undefined) {
    if (until > now) return refusal(until, now);
    throttledUntil.delete(key);
  }

  waitUntil(
    consumeRateLimit(key, STOREFRONT_RATE_LIMIT).then((decision) => {
      if (decision.allowed) return;
      prune(Date.now());
      throttledUntil.set(key, decision.resetAt.getTime());
    }),
  );
  return null;
}
