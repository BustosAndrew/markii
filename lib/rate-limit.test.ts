import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decide, rateLimitHeaders, windowStartFor, type RateLimitPolicy } from "./rate-limit";

/**
 * The rate-limit arithmetic.
 *
 * Worth pinning because every mistake here is silent in the direction that
 * matters: an off-by-one lets one extra request through, a wrong window lets a
 * caller reset early, and a `Retry-After` of zero turns a refusal into a hot
 * loop. None of those throws.
 */

const POLICY: RateLimitPolicy = { limit: 3, windowMs: 60_000 };
const NOW = new Date("2026-09-07T12:00:30.000Z");
const WINDOW = new Date("2026-09-07T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("windowStartFor", () => {
  it("floors to the window boundary", () => {
    expect(windowStartFor(NOW, 60_000).toISOString()).toBe("2026-09-07T12:00:00.000Z");
  });

  /**
   * Aligned to the epoch, not to first contact — every caller shares a boundary,
   * so a burst is reasonable about across callers rather than each drifting.
   */
  it("puts two callers in the same window whenever they first arrive", () => {
    const early = windowStartFor(new Date("2026-09-07T12:00:01.000Z"), 60_000);
    const late = windowStartFor(new Date("2026-09-07T12:00:59.999Z"), 60_000);
    expect(early.getTime()).toBe(late.getTime());
  });

  it("rolls at the boundary, not a millisecond before", () => {
    const last = windowStartFor(new Date("2026-09-07T12:00:59.999Z"), 60_000);
    const next = windowStartFor(new Date("2026-09-07T12:01:00.000Z"), 60_000);
    expect(next.getTime() - last.getTime()).toBe(60_000);
  });
});

describe("decide", () => {
  /**
   * The store increments before asking, so a count *equal* to the limit is the
   * last permitted request. Getting this backwards costs a caller one request
   * of their stated allowance, which is the kind of thing nobody reports and
   * everybody notices.
   */
  it("allows the request that exactly reaches the limit", () => {
    expect(decide(3, WINDOW, POLICY).allowed).toBe(true);
    expect(decide(3, WINDOW, POLICY).remaining).toBe(0);
  });

  it("refuses the one after", () => {
    expect(decide(4, WINDOW, POLICY).allowed).toBe(false);
  });

  it("reports what is left", () => {
    expect(decide(1, WINDOW, POLICY).remaining).toBe(2);
    expect(decide(2, WINDOW, POLICY).remaining).toBe(1);
  });

  it("never reports negative headroom once over", () => {
    expect(decide(99, WINDOW, POLICY).remaining).toBe(0);
  });

  it("resets at the end of the window it was counted in", () => {
    expect(decide(1, WINDOW, POLICY).resetAt.toISOString()).toBe("2026-09-07T12:01:00.000Z");
  });

  /** Half a window has passed at NOW, so 30s remain and it rounds up. */
  it("reports seconds until reset, rounded up", () => {
    expect(decide(4, WINDOW, POLICY).retryAfterSeconds).toBe(30);
  });

  /**
   * **Never zero.** A caller told to retry in zero seconds retries immediately,
   * which is precisely the behaviour being limited.
   */
  it("never tells a caller to retry in zero seconds", () => {
    vi.setSystemTime(new Date("2026-09-07T12:00:59.999Z"));
    expect(decide(4, WINDOW, POLICY).retryAfterSeconds).toBeGreaterThanOrEqual(1);

    vi.setSystemTime(new Date("2026-09-07T12:01:30.000Z"));
    expect(decide(4, WINDOW, POLICY).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe("rateLimitHeaders", () => {
  it("publishes the budget on an allowed request", () => {
    const headers = rateLimitHeaders(decide(1, WINDOW, POLICY), POLICY);
    expect(headers["RateLimit-Limit"]).toBe("3");
    expect(headers["RateLimit-Remaining"]).toBe("2");
  });

  /**
   * `Retry-After` on a *successful* reply reads as "wait before continuing",
   * which is not what is being said — it belongs only on the refusal.
   */
  it("omits Retry-After unless the request was refused", () => {
    expect(rateLimitHeaders(decide(1, WINDOW, POLICY), POLICY)["Retry-After"]).toBeUndefined();
    expect(rateLimitHeaders(decide(4, WINDOW, POLICY), POLICY)["Retry-After"]).toBe("30");
  });
});
