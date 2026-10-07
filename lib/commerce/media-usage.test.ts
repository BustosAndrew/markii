import { describe, expect, it } from "vitest";
import { planCatalog } from "../plans";
import { currentPeriodStart, mediaQuotaFrom, storageAllows } from "./media-usage";

/** G5 media quotas — the numbers and the fit rule, not the queries that measure against them. */

const GIB = 1024 ** 3;
const byPlan = Object.fromEntries(planCatalog().map((p) => [p.planId, mediaQuotaFrom(p.media)]));

describe("mediaQuotaFrom", () => {
  it("matches the plan table in docs/PRICING.md §3", () => {
    expect(byPlan.starter).toEqual({ storageBytes: 10 * GIB, deliveryBytes: 50 * GIB });
    expect(byPlan.growth).toEqual({ storageBytes: 50 * GIB, deliveryBytes: 250 * GIB });
    expect(byPlan.scale).toEqual({ storageBytes: 250 * GIB, deliveryBytes: 1024 ** 4 });
  });

  it("allows more delivery than storage on every plan", () => {
    // G5's central finding: egress is the expensive half, and a plan that let
    // you store more than you could ever deliver would be gating the wrong one.
    for (const quota of Object.values(byPlan)) {
      expect(quota.deliveryBytes).toBeGreaterThan(quota.storageBytes);
    }
  });
});

describe("storageAllows", () => {
  const quota = { storageBytes: 10 * GIB, deliveryBytes: 50 * GIB };

  it("allows a file that fits", () => {
    expect(storageAllows(5 * GIB, 1 * GIB, quota)).toEqual({ allowed: true });
  });

  it("allows a file that lands exactly on the allowance", () => {
    expect(storageAllows(9 * GIB, 1 * GIB, quota)).toEqual({ allowed: true });
  });

  /**
   * The rule that makes the quota a quota: starting under the line is not
   * enough. Without it the merchant at 9.9 GB stores a 2 GB file and sits 19%
   * over, and the allowance belongs to whoever uploads the largest file last.
   */
  it("refuses a file that starts under the line but would end over it", () => {
    const check = storageAllows(9.9 * GIB, 2 * GIB, quota);
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.overByBytes).toBe(9.9 * GIB + 2 * GIB - 10 * GIB);
    expect(check.quotaBytes).toBe(10 * GIB);
  });

  it("refuses anything once already over — a downgrade below what is stored", () => {
    expect(storageAllows(40 * GIB, 1, quota).allowed).toBe(false);
  });
});

describe("currentPeriodStart", () => {
  it("is the first instant of the UTC month", () => {
    expect(currentPeriodStart(new Date("2026-08-14T23:30:00Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("does not drift across a year boundary", () => {
    expect(currentPeriodStart(new Date("2026-01-01T00:00:00Z")).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("uses UTC, not local time", () => {
    // A merchant in UTC+13 must not have their delivery quota reset a day early
    // relative to the billing period it is measured against.
    expect(currentPeriodStart(new Date("2026-08-01T00:30:00Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });
});
