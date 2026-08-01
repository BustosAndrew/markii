import { describe, expect, it } from "vitest";
import { MEDIA_QUOTAS, currentPeriodStart } from "./media-usage";

/** G5 media quotas — the numbers, not the queries that measure against them. */

describe("MEDIA_QUOTAS", () => {
  it("matches the quotas G5 proposes", () => {
    expect(MEDIA_QUOTAS.starter.storageBytes).toBe(10 * 1024 ** 3);
    expect(MEDIA_QUOTAS.growth.storageBytes).toBe(50 * 1024 ** 3);
    expect(MEDIA_QUOTAS.scale.storageBytes).toBe(250 * 1024 ** 3);
    expect(MEDIA_QUOTAS.starter.deliveryBytes).toBe(50 * 1024 ** 3);
    expect(MEDIA_QUOTAS.growth.deliveryBytes).toBe(250 * 1024 ** 3);
    expect(MEDIA_QUOTAS.scale.deliveryBytes).toBe(1024 ** 4);
  });

  it("allows more delivery than storage on every plan", () => {
    // G5's central finding: egress is the expensive half, and a plan that let
    // you store more than you could ever deliver would be gating the wrong one.
    for (const plan of Object.values(MEDIA_QUOTAS)) {
      expect(plan.deliveryBytes).toBeGreaterThan(plan.storageBytes);
    }
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
