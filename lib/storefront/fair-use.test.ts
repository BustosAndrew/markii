import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadLimitKey,
  retryWindowCopy,
  storefrontLimitKey,
  storefrontSlugFromPath,
  throttledStorefrontBody,
} from "./fair-use";
import { DOWNLOAD_RATE_LIMIT, STOREFRONT_RATE_LIMIT, limitFromEnv } from "../rate-limit";

/** Storefront fair use (G12) — the parts that decide what is counted and what is said. */

describe("storefrontSlugFromPath", () => {
  it("reads the store from a direct /_sites/ path", () => {
    expect(storefrontSlugFromPath("/_sites/acme")).toBe("acme");
    expect(storefrontSlugFromPath("/_sites/acme/p/blue-tee")).toBe("acme");
  });

  /**
   * The throttle keys on the slug, so two spellings of one store must be one
   * key — or the same page asked for as `/_sites/Acme` gets a second budget.
   */
  it("normalises case and escapes", () => {
    expect(storefrontSlugFromPath("/_sites/Acme/")).toBe("acme");
    expect(storefrontSlugFromPath("/_sites/ac%6De")).toBe("acme");
  });

  it("is null for anything that is not a storefront path", () => {
    expect(storefrontSlugFromPath("/")).toBeNull();
    expect(storefrontSlugFromPath("/dashboard")).toBeNull();
    expect(storefrontSlugFromPath("/_sites")).toBeNull();
    expect(storefrontSlugFromPath("/_sites/")).toBeNull();
    expect(storefrontSlugFromPath("/x/_sites/acme")).toBeNull();
  });

  it("is null for a malformed escape rather than throwing in the proxy", () => {
    expect(storefrontSlugFromPath("/_sites/%E0%A4%A")).toBeNull();
  });
});

describe("keys", () => {
  it("separates stores, so one crawl does not spend another store's budget", () => {
    expect(storefrontLimitKey("a", "203.0.113.9")).not.toBe(storefrontLimitKey("b", "203.0.113.9"));
  });

  /** The token is the shopper's credential; the counter table holds ids, never secrets. */
  it("keys a download on the grant id, never the token", () => {
    expect(downloadLimitKey(42)).toBe("dl:42");
  });
});

describe("policies", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throttles storefronts per minute and downloads per day", () => {
    expect(STOREFRONT_RATE_LIMIT.windowMs).toBe(60_000);
    expect(DOWNLOAD_RATE_LIMIT.windowMs).toBe(24 * 60 * 60_000);
  });

  /**
   * A `NaN` limit refuses everything (`count <= NaN` is false), so a typo in an
   * override must fall back rather than take every storefront down.
   */
  it("ignores an override that is not a positive number", () => {
    vi.stubEnv("SOME_LIMIT", "abc");
    expect(limitFromEnv("SOME_LIMIT", 240)).toBe(240);
    vi.stubEnv("SOME_LIMIT", "0");
    expect(limitFromEnv("SOME_LIMIT", 240)).toBe(240);
    vi.stubEnv("SOME_LIMIT", "-5");
    expect(limitFromEnv("SOME_LIMIT", 240)).toBe(240);
    vi.stubEnv("SOME_LIMIT", "600");
    expect(limitFromEnv("SOME_LIMIT", 240)).toBe(600);
  });
});

describe("copy", () => {
  it("tells a throttled caller when to come back, and agents how to stop being throttled", () => {
    const body = throttledStorefrontBody(12);
    expect(body).toContain("Retry in 12s");
    expect(body).toContain("/llms.txt");
    expect(body).toContain("/api/search");
  });

  it("states a retry window in whole units, never zero", () => {
    expect(retryWindowCopy(1)).toBe("1 minute");
    expect(retryWindowCopy(61)).toBe("2 minutes");
    expect(retryWindowCopy(3600)).toBe("1 hour");
    expect(retryWindowCopy(5 * 3600 + 1)).toBe("6 hours");
  });
});
