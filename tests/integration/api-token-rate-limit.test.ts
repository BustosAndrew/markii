import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_TOKEN_RATE_LIMIT, MCP_RATE_LIMIT } from "@/lib/rate-limit";
import { tokenLimitKey } from "@/lib/auth/token-rate-limit";
import { Cleanup, Client, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The per-token rate limit on the REST surface (G12).
 *
 * MCP was limited per token from the day it shipped; the same token on
 * `/api/*` was limited by nothing, so a limit met on one surface was routable
 * around on the other. This proves the second door is now counted — on the
 * token's real key, so the assertion cannot pass against a counter the handler
 * does not read — and that a cookie session is deliberately left alone.
 *
 * The refusal is driven by pushing the token's own counter to the ceiling
 * directly rather than by spending 300 round trips, for the reason the MCP
 * suite gives: a fixed window that resets mid-loop is the documented trade,
 * not a bug, and a loop long enough to straddle one is flaky by design.
 */
describe("API token rate limit", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let tokenId: string;
  let bearer: string;

  const viaToken = (path: string) =>
    fetch(`${BASE_URL}${path}`, { headers: { authorization: `Bearer ${bearer}` } });

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "tokenrl");
    cleanup.merchantEmails.push(email);
    const created = await merchant.post("/api/org/tokens", { label: "rest-limit", role: "viewer" });
    expect(created.status).toBe(201);
    tokenId = created.json.id;
    bearer = created.json.token;
  }, 180_000);

  afterAll(async () => {
    await sql`delete from rate_limit_counters where key = ${tokenLimitKey(tokenId)}`;
    await cleanup.run();
  });

  it("publishes the token's budget on a successful REST reply", async () => {
    const res = await viaToken("/api/sites");
    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-limit")).toBe(String(API_TOKEN_RATE_LIMIT.limit));
    const remaining = Number(res.headers.get("ratelimit-remaining"));
    expect(Number.isFinite(remaining)).toBe(true);
    // Only a refusal carries Retry-After; on a 200 it would read as "wait".
    expect(res.headers.get("retry-after")).toBeNull();
  }, 60_000);

  it("counts each request against the token, across separate HTTP requests", async () => {
    const before = Number((await viaToken("/api/sites")).headers.get("ratelimit-remaining"));
    const after = Number((await viaToken("/api/sites")).headers.get("ratelimit-remaining"));
    expect(after).toBeLessThan(before);
  }, 60_000);

  /**
   * A `404` spent a request too. The budget rides error replies so a client
   * polling a missing resource still sees its allowance falling.
   */
  it("carries the budget on an error reply as well", async () => {
    const res = await viaToken("/api/sites/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.headers.get("ratelimit-remaining")).not.toBeNull();
  }, 60_000);

  /**
   * The limiter is keyed on the token, and the refusal must come from *that*
   * key. Setting the count at the ceiling on the row the handler reads — and
   * nothing else — is what shows the two are the same row.
   */
  it("refuses with 429 RATE_LIMITED and Retry-After once the token's window is spent", async () => {
    const windowMs = API_TOKEN_RATE_LIMIT.windowMs;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    await sql`
      insert into rate_limit_counters (key, window_start, count)
      values (${tokenLimitKey(tokenId)}, ${windowStart.toISOString()}, ${API_TOKEN_RATE_LIMIT.limit})
      on conflict (key) do update
        set window_start = excluded.window_start, count = excluded.count
    `;

    const res = await viaToken("/api/sites");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("ratelimit-remaining")).toBe("0");

    // The refusal is before authorization: a read the token may make is
    // refused for budget, not permission.
    expect(body.error.code).not.toBe("FORBIDDEN");

    await sql`delete from rate_limit_counters where key = ${tokenLimitKey(tokenId)}`;
    expect((await viaToken("/api/sites")).status).toBe(200);
  }, 60_000);

  /**
   * A dashboard render fans out many calls; the ceiling that catches a script
   * would catch a merchant with two tabs open first. Sessions are gated on how
   * they come to exist (MFA, the auth limits), not on how often they read.
   */
  it("does not count or stamp a cookie session", async () => {
    const res = await merchant.getRaw("/api/sites");
    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-limit")).toBeNull();
    expect(res.headers.get("ratelimit-remaining")).toBeNull();
  }, 60_000);

  /**
   * The MCP `read_*` tools forward in-process to these handlers with the
   * caller's own token, so an MCP read lands on both counters. The REST ceiling
   * therefore has to sit above the MCP one or an MCP client would be refused by
   * the REST counter first — pinned in the unit test too, asserted here against
   * the running server's own numbers.
   */
  it("advertises a ceiling above the MCP limit", async () => {
    const rest = Number((await viaToken("/api/sites")).headers.get("ratelimit-limit"));
    expect(rest).toBeGreaterThan(MCP_RATE_LIMIT.limit);
  }, 60_000);
});
