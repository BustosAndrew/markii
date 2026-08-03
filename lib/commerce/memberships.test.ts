import { describe, expect, it } from "vitest";
import { extendedEndsAt, isMembershipActive, membershipStatus } from "./memberships";

const NOW = new Date("2026-08-03T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

describe("membershipStatus", () => {
  it("is active inside an open period", () => {
    expect(membershipStatus({ startsAt: day(-1), endsAt: day(30), revokedAt: null }, NOW)).toBe(
      "active",
    );
  });

  it("treats a null endsAt as a lifetime membership, not an unset field", () => {
    expect(membershipStatus({ startsAt: day(-400), endsAt: null, revokedAt: null }, NOW)).toBe(
      "active",
    );
  });

  it("expires without anything having to run", () => {
    // The point of deriving status: no scheduler exists to write "expired".
    expect(membershipStatus({ startsAt: day(-40), endsAt: day(-1), revokedAt: null }, NOW)).toBe(
      "expired",
    );
  });

  it("distinguishes not-yet-started from expired", () => {
    expect(membershipStatus({ startsAt: day(5), endsAt: day(40), revokedAt: null }, NOW)).toBe(
      "scheduled",
    );
  });

  it("lets revocation outrank a period that is still running", () => {
    expect(
      membershipStatus({ startsAt: day(-5), endsAt: day(30), revokedAt: day(-1) }, NOW),
    ).toBe("revoked");
  });

  it("does not apply a revocation dated in the future", () => {
    expect(
      membershipStatus({ startsAt: day(-5), endsAt: day(30), revokedAt: day(2) }, NOW),
    ).toBe("active");
  });

  it("expires exactly on the boundary rather than a moment after", () => {
    // endsAt == now must not still grant access.
    expect(membershipStatus({ startsAt: day(-5), endsAt: NOW, revokedAt: null }, NOW)).toBe(
      "expired",
    );
  });

  it("agrees with isMembershipActive", () => {
    const row = { startsAt: day(-1), endsAt: day(1), revokedAt: null };
    expect(isMembershipActive(row, NOW)).toBe(true);
    expect(isMembershipActive({ ...row, revokedAt: day(-1) }, NOW)).toBe(false);
  });
});

describe("extendedEndsAt", () => {
  it("starts from now for a first purchase", () => {
    expect(extendedEndsAt(null, 30, NOW)).toEqual(day(30));
  });

  it("stacks onto unused time when renewing early", () => {
    // Renewing with 20 days left must not forfeit those 20 days.
    const current = { endsAt: day(20), revokedAt: null };
    expect(extendedEndsAt(current, 30, NOW)).toEqual(day(50));
  });

  it("restarts from now after a lapse rather than back-dating into the gap", () => {
    const lapsed = { endsAt: day(-10), revokedAt: null };
    expect(extendedEndsAt(lapsed, 30, NOW)).toEqual(day(30));
  });

  it("restarts from now when the previous membership was revoked", () => {
    const revoked = { endsAt: day(60), revokedAt: day(-2) };
    expect(extendedEndsAt(revoked, 30, NOW)).toEqual(day(30));
  });

  it("never shortens a lifetime membership into a finite one", () => {
    const lifetime = { endsAt: null, revokedAt: null };
    expect(extendedEndsAt(lifetime, 30, NOW)).toBeNull();
  });

  it("grants a lifetime membership when days is null", () => {
    expect(extendedEndsAt({ endsAt: day(10), revokedAt: null }, null, NOW)).toBeNull();
  });

  it("treats a revoked lifetime membership as re-startable", () => {
    const revokedLifetime = { endsAt: null, revokedAt: day(-1) };
    expect(extendedEndsAt(revokedLifetime, 30, NOW)).toEqual(day(30));
  });
});
