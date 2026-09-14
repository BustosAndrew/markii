import { describe, expect, it } from "vitest";
import { AUTH_RATE_LIMITS, ipKeyFor, rateLimited, retryCopy, subjectKeyFor } from "./rate-limits";

/**
 * The pure edges of the auth limiter: what a counter is keyed on, and what a
 * refusal says. Whether the routes actually refuse is
 * `tests/integration/auth-rate-limit.test.ts`.
 */

describe("subjectKeyFor", () => {
  it("keys sign-in and reset on the whole address, case-folded", () => {
    const a = subjectKeyFor("signIn", "Me@Example.com");
    expect(a).toBe(subjectKeyFor("signIn", "  me@example.com "));
    expect(a).not.toBe(subjectKeyFor("signIn", "you@example.com"));
    expect(subjectKeyFor("passwordReset", "me@example.com")).not.toBe(a);
  });

  it("keys sign-up on the domain, so a thousand addresses at one host share a bucket", () => {
    const a = subjectKeyFor("signUp", "a1@throwaway.example");
    expect(a).toBe(subjectKeyFor("signUp", "A999@Throwaway.Example"));
    expect(a).not.toBe(subjectKeyFor("signUp", "a1@other.example"));
  });

  /**
   * `rate_limit_counters` is a table nothing reads back and a sweep prunes on a
   * schedule — it must never be a list of every address ever typed into a form.
   */
  it("never puts the address itself in the key", () => {
    const key = subjectKeyFor("signIn", "someone@example.com")!;
    expect(key).not.toContain("someone");
    expect(key).not.toContain("example.com");
    expect(key).toMatch(/^auth:signIn:subject:[0-9a-f]{32}$/);
  });

  it("returns null for anything that is not an address, rather than one shared bucket", () => {
    expect(subjectKeyFor("signIn", undefined)).toBeNull();
    expect(subjectKeyFor("signIn", 42)).toBeNull();
    expect(subjectKeyFor("signIn", "not-an-email")).toBeNull();
    expect(subjectKeyFor("signIn", "@nobody")).toBeNull();
    expect(subjectKeyFor("signIn", "trailing@")).toBeNull();
  });
});

describe("ipKeyFor", () => {
  it("scopes per route, so sign-in attempts do not spend the sign-up allowance", () => {
    expect(ipKeyFor("signIn", "203.0.113.9")).not.toBe(ipKeyFor("signUp", "203.0.113.9"));
  });
});

describe("AUTH_RATE_LIMITS", () => {
  it("is stricter per subject than per address everywhere except sign-up", () => {
    // Sign-up's subject is a domain shared by many people; the others are one person's address.
    expect(AUTH_RATE_LIMITS.signIn.subject.limit).toBeLessThan(AUTH_RATE_LIMITS.signIn.ip.limit);
    expect(AUTH_RATE_LIMITS.passwordReset.subject.limit).toBeLessThan(
      AUTH_RATE_LIMITS.passwordReset.ip.limit,
    );
    expect(AUTH_RATE_LIMITS.signUp.subject.limit).toBeGreaterThan(AUTH_RATE_LIMITS.signUp.ip.limit);
  });

  it("never has a zero or negative allowance", () => {
    for (const scope of Object.values(AUTH_RATE_LIMITS)) {
      expect(scope.ip.limit).toBeGreaterThan(0);
      expect(scope.subject.limit).toBeGreaterThan(0);
    }
  });
});

describe("rateLimited", () => {
  const decision = { allowed: false as const, remaining: 0, resetAt: new Date(), retryAfterSeconds: 61 };
  const policy = { limit: 10, windowMs: 60_000 };

  it("is a 429 carrying Retry-After and the RateLimit headers", () => {
    const err = rateLimited({ allowed: false, dimension: "subject", decision, policy });
    expect(err.status).toBe(429);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.headers?.["Retry-After"]).toBe("61");
    expect(err.headers?.["RateLimit-Limit"]).toBe("10");
  });

  /**
   * "Too many attempts for this account" would confirm the account exists. The
   * copy is the same whichever dimension refused.
   */
  it("says the same thing whichever dimension refused", () => {
    const byIp = rateLimited({ allowed: false, dimension: "ip", decision, policy });
    const bySubject = rateLimited({ allowed: false, dimension: "subject", decision, policy });
    expect(byIp.message).toBe(bySubject.message);
    expect(byIp.message).not.toMatch(/account|address|email/i);
  });

  it("rounds the wait up to whole minutes and never says zero", () => {
    expect(retryCopy({ ...decision, retryAfterSeconds: 61 })).toBe("Try again in 2 minutes.");
    expect(retryCopy({ ...decision, retryAfterSeconds: 1 })).toBe("Try again in 1 minute.");
  });
});
