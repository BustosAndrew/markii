import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_RATE_LIMITS, subjectKeyFor } from "@/lib/auth/rate-limits";
import { Cleanup, Client, createTestStore, sql } from "./helpers";

/**
 * Rate limits on the unauthenticated auth routes (G12).
 *
 * Every request here carries its own `x-forwarded-for`, because a dev server
 * has no proxy in front of it and would otherwise see no address at all — and
 * the limiter deliberately applies no address limit to an addressless caller.
 * Addresses come from TEST-NET-2 (`198.51.100.0/24`), which is reserved and
 * never routed, so the counters this file writes cannot collide with anyone
 * real on the shared database.
 *
 * Most attempts are made with an **empty password**, which the schema refuses
 * as a 400 before Supabase is called. That is on purpose twice over: it keeps
 * the suite from spending Supabase's own auth allowance, and it is the
 * property most worth proving — a limiter that only counted well-formed
 * attempts would be sidestepped by getting the password rules wrong.
 */
describe("auth rate limits", () => {
  const client = new Client();
  const cleanup = new Cleanup();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const usedIps: string[] = [];
  const usedEmails: string[] = [];
  let storeSlug: string;

  let nextIp = 1;
  function freshIp() {
    const ip = `198.51.100.${nextIp++}`;
    usedIps.push(ip);
    return ip;
  }
  function freshEmail(label: string) {
    const email = `rl-${label}-${stamp}-${usedEmails.length}@markii.shop`;
    usedEmails.push(email);
    return email;
  }
  const from = (ip: string) => ({ "x-forwarded-for": ip });

  /**
   * Windows are fixed and aligned to the epoch, so a loop that straddles a
   * boundary sees its count reset halfway through — the documented trade of a
   * fixed window, and exactly what happened the first time this file ran at
   * 21:29 against a 15-minute window. Wait for the next window rather than
   * assert something weaker. The longest loop here is ~20s; the wait stays
   * under the 60s test timeout.
   */
  async function roomInWindow(windowMs: number, needMs = 40_000) {
    const left = windowMs - (Date.now() % windowMs);
    if (left < needMs) await new Promise((r) => setTimeout(r, left + 500));
  }

  beforeAll(async () => {
    storeSlug = (await createTestStore(cleanup, "rate-limit")).slug;
  });

  afterAll(async () => {
    await cleanup.run();
    const keys = [
      ...usedIps.flatMap((ip) => [
        `auth:signIn:ip:${ip}`,
        `auth:signUp:ip:${ip}`,
        `auth:passwordReset:ip:${ip}`,
      ]),
      ...usedEmails.flatMap((e) =>
        (["signIn", "signUp", "passwordReset"] as const).map((s) => subjectKeyFor(s, e)!),
      ),
    ];
    await sql`delete from rate_limit_counters where key in ${sql(keys)}`;
  });

  it("refuses the eleventh sign-in for one address in a window, whatever the password", async () => {
    const { limit, windowMs } = AUTH_RATE_LIMITS.signIn.subject;
    await roomInWindow(windowMs);
    const email = freshEmail("email");

    for (let i = 0; i < limit; i++) {
      // A different client address each time, so only the per-email dimension is in play.
      const r = await client.call("POST", "/api/auth/sign-in", { email, password: "" }, from(freshIp()));
      expect(r.status, `attempt ${i + 1}`).toBe(400);
    }

    // A genuine attempt — right shape, wrong password — is refused on the same count.
    const refused = await client.call(
      "POST",
      "/api/auth/sign-in",
      { email, password: "Definitely-Wrong-1" },
      from(freshIp()),
    );
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe("RATE_LIMITED");
    expect(refused.json.error.message).toMatch(/^Too many attempts\. Try again in \d+ minutes?\.$/);
    expect(refused.json.error.message).not.toMatch(/account/i);
    expect(refused.json.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("carries Retry-After and the RateLimit headers on the refusal", async () => {
    await roomInWindow(AUTH_RATE_LIMITS.signIn.subject.windowMs);
    const email = freshEmail("headers");
    const ip = freshIp();
    for (let i = 0; i < AUTH_RATE_LIMITS.signIn.subject.limit; i++) {
      await client.call("POST", "/api/auth/sign-in", { email, password: "" }, from(freshIp()));
    }
    const res = await fetch(`${process.env.MARKII_TEST_BASE_URL ?? "http://localhost:3000"}/api/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", ...from(ip) },
      body: JSON.stringify({ email, password: "" }),
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("ratelimit-limit")).toBe(String(AUTH_RATE_LIMITS.signIn.subject.limit));
    expect(res.headers.get("ratelimit-remaining")).toBe("0");
  });

  it("does not let one address's exhaustion touch another address from the same client", async () => {
    await roomInWindow(AUTH_RATE_LIMITS.signIn.subject.windowMs);
    const ip = freshIp();
    const exhausted = freshEmail("exhausted");
    for (let i = 0; i <= AUTH_RATE_LIMITS.signIn.subject.limit; i++) {
      await client.call("POST", "/api/auth/sign-in", { email: exhausted, password: "" }, from(ip));
    }
    const other = await client.call(
      "POST",
      "/api/auth/sign-in",
      { email: freshEmail("other"), password: "" },
      from(ip),
    );
    expect(other.status).toBe(400);
  });

  it("refuses a client address that sprays many different emails", async () => {
    const { limit, windowMs } = AUTH_RATE_LIMITS.signIn.ip;
    await roomInWindow(windowMs);
    const ip = freshIp();
    for (let i = 0; i < limit; i++) {
      const r = await client.call(
        "POST",
        "/api/auth/sign-in",
        { email: freshEmail(`spray${i}`), password: "" },
        from(ip),
      );
      expect(r.status, `attempt ${i + 1}`).toBe(400);
    }
    const refused = await client.call(
      "POST",
      "/api/auth/sign-in",
      { email: freshEmail("spray-last"), password: "" },
      from(ip),
    );
    expect(refused.status).toBe(429);
  });

  it("limits sign-up per client address, counting attempts the schema refuses", async () => {
    const { limit, windowMs } = AUTH_RATE_LIMITS.signUp.ip;
    await roomInWindow(windowMs);
    const ip = freshIp();
    for (let i = 0; i < limit; i++) {
      const r = await client.call(
        "POST",
        "/api/auth/sign-up",
        { email: freshEmail(`up${i}`), password: "short" },
        from(ip),
      );
      expect(r.status, `attempt ${i + 1}`).toBe(400);
    }
    const refused = await client.call(
      "POST",
      "/api/auth/sign-up",
      { email: freshEmail("up-last"), password: "short" },
      from(ip),
    );
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe("RATE_LIMITED");
  });

  it("counts a body that is not even JSON, rather than 500ing past the limiter", async () => {
    await roomInWindow(AUTH_RATE_LIMITS.signUp.ip.windowMs);
    const ip = freshIp();
    const base = process.env.MARKII_TEST_BASE_URL ?? "http://localhost:3000";
    const post = () =>
      fetch(`${base}/api/auth/sign-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...from(ip) },
        body: "this is not json",
      });
    for (let i = 0; i < AUTH_RATE_LIMITS.signUp.ip.limit; i++) {
      expect((await post()).status, `attempt ${i + 1}`).toBe(400);
    }
    expect((await post()).status).toBe(429);
  });

  it("limits password resets per address, so the form cannot be used to spam someone", async () => {
    const { limit, windowMs } = AUTH_RATE_LIMITS.passwordReset.subject;
    await roomInWindow(windowMs);
    const email = freshEmail("reset");
    for (let i = 0; i < limit; i++) {
      const r = await client.call("POST", "/api/auth/reset-password", { email }, from(freshIp()));
      // Always 200 for a well-formed address — the route never reveals whether one exists.
      expect(r.status, `attempt ${i + 1}`).toBe(200);
    }
    const refused = await client.call("POST", "/api/auth/reset-password", { email }, from(freshIp()));
    expect(refused.status).toBe(429);
  });

  it("applies the same sign-in limit to shoppers, and a form post is told in the redirect", async () => {
    await roomInWindow(AUTH_RATE_LIMITS.signIn.subject.windowMs);
    const email = freshEmail("shopper");
    const path = `/_sites/${storeSlug}/api/auth/sign-in`;
    for (let i = 0; i < AUTH_RATE_LIMITS.signIn.subject.limit; i++) {
      const r = await client.call("POST", path, { email, password: "" }, from(freshIp()));
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    const json = await client.call("POST", path, { email, password: "" }, from(freshIp()));
    expect(json.status).toBe(429);

    const base = process.env.MARKII_TEST_BASE_URL ?? "http://localhost:3000";
    const form = await fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...from(freshIp()) },
      body: new URLSearchParams({ email, password: "" }).toString(),
    });
    expect(form.status).toBe(303);
    const location = form.headers.get("location") ?? "";
    expect(decodeURIComponent(location)).toMatch(/error=Too many attempts/);
  });

  it("limits shopper sign-up per address too, since it sends mail on the merchant's name", async () => {
    await roomInWindow(AUTH_RATE_LIMITS.signUp.ip.windowMs);
    const ip = freshIp();
    const path = `/_sites/${storeSlug}/api/auth/sign-up`;
    for (let i = 0; i < AUTH_RATE_LIMITS.signUp.ip.limit; i++) {
      const r = await client.call(
        "POST",
        path,
        { email: freshEmail(`shop-up${i}`), password: "short" },
        from(ip),
      );
      expect(r.status, `attempt ${i + 1}`).toBe(400);
    }
    const refused = await client.call(
      "POST",
      path,
      { email: freshEmail("shop-up-last"), password: "short" },
      from(ip),
    );
    expect(refused.status).toBe(429);
  });
});
