import { afterEach, describe, expect, it } from "vitest";
import { authenticateCron } from "./auth";

/**
 * These tests guard a bypass, not a feature.
 *
 * A `system` actor authorizes every permission and waives MFA step-up. This
 * module is the only thing between an HTTP request and one of those, so the
 * cases that matter are the refusals — a missing secret, a weak secret, a wrong
 * secret. A regression here is not a broken cron; it is an unauthenticated
 * caller with permission to bill every merchant on the platform.
 */

const GOOD = "a".repeat(32);
const original = process.env.CRON_SECRET;

afterEach(() => {
  if (original === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = original;
});

function request(authorization?: string): Request {
  return new Request("https://markii.shop/api/cron/billing", {
    headers: authorization ? { authorization } : {},
  });
}

describe("authenticateCron", () => {
  it("refuses when CRON_SECRET is unset, rather than running open", () => {
    delete process.env.CRON_SECRET;

    const result = authenticateCron(request(`Bearer ${GOOD}`));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 503, not 401: nothing is wrong with the caller — the deployment cannot
    // run scheduled work at all, and an operator needs to tell those apart.
    expect(result.status).toBe(503);
    expect(result.code).toBe("CONFIGURATION_REQUIRED");
  });

  it("refuses a secret short enough to guess", () => {
    process.env.CRON_SECRET = "short";

    const result = authenticateCron(request("Bearer short"));

    // The secret presented is *correct*. It is still refused, because a
    // guessable secret protecting a permission bypass is not protection.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
  });

  it("refuses a request with no authorization header", () => {
    process.env.CRON_SECRET = GOOD;

    const result = authenticateCron(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it("refuses a wrong secret without revealing which part was wrong", () => {
    process.env.CRON_SECRET = GOOD;

    const result = authenticateCron(request(`Bearer ${"b".repeat(32)}`));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.message).toBe("Unauthorized.");
    // Says nothing about length, prefix, or whether a secret is configured.
    expect(result.message).not.toContain("CRON_SECRET");
  });

  it("refuses a correct secret presented without the Bearer scheme", () => {
    process.env.CRON_SECRET = GOOD;

    const result = authenticateCron(request(GOOD));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it("refuses a secret of the right length that differs in one byte", () => {
    process.env.CRON_SECRET = GOOD;

    const result = authenticateCron(request(`Bearer ${"a".repeat(31)}b`));

    expect(result.ok).toBe(false);
  });

  it("mints an org-less system actor for a valid secret", () => {
    process.env.CRON_SECRET = GOOD;

    const result = authenticateCron(request(`Bearer ${GOOD}`));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor.type).toBe("system");
    // The sweep scopes the actor per organization. One carrying an org here
    // would attribute every audit row to whichever merchant sorted first.
    expect(result.actor.orgId).toBeNull();
  });

  it("tolerates surrounding whitespace in the header", () => {
    process.env.CRON_SECRET = GOOD;

    expect(authenticateCron(request(`  Bearer ${GOOD}  `)).ok).toBe(true);
  });
});
