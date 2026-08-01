import { describe, expect, it } from "vitest";
import { amountOf, statusOf } from "./discounts";
import type { Discount } from "../db";

/** Discount arithmetic and status (§18.5) — pure, no database. */

const discount = (over: Partial<Discount> & { type: Discount["type"] }): Discount => ({
  id: 1,
  siteId: 1,
  code: "TEST",
  title: "Test discount",
  percentageBps: null,
  valueMinor: null,
  appliesToScope: "order",
  appliesToIds: [],
  minimumSubtotalMinor: null,
  customerEligibility: "all",
  eligibleCustomerIds: [],
  usageLimit: null,
  usageLimitPerCustomer: null,
  combinesWithProduct: false,
  combinesWithOrder: false,
  combinesWithShipping: false,
  startsAt: null,
  endsAt: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("amountOf", () => {
  it("takes a percentage, rounded half-up in integer arithmetic", () => {
    const d = discount({ type: "percentage", percentageBps: 1500 });
    expect(amountOf(d, 2800)).toBe(420);
    // 1999 * 15% = 299.85 -> 300
    expect(amountOf(d, 1999)).toBe(300);
  });

  it("takes a fixed amount", () => {
    expect(amountOf(discount({ type: "fixed", valueMinor: 1000 }), 5000)).toBe(1000);
  });

  it("caps a fixed discount at what it applies to", () => {
    // A £500 code on a £14 cart takes off £14, never £500.
    expect(amountOf(discount({ type: "fixed", valueMinor: 50000 }), 1400)).toBe(1400);
  });

  it("never returns more than the base, at any percentage", () => {
    for (const bps of [1, 5000, 10000]) {
      const d = discount({ type: "percentage", percentageBps: bps });
      for (const base of [1, 99, 1400, 999999]) {
        expect(amountOf(d, base)).toBeLessThanOrEqual(base);
      }
    }
  });

  it("takes nothing off the subtotal for free shipping", () => {
    // Free shipping acts on the shipping component, not the goods.
    expect(amountOf(discount({ type: "free_shipping" }), 5000)).toBe(0);
  });

  it("is zero on an empty base", () => {
    expect(amountOf(discount({ type: "percentage", percentageBps: 2000 }), 0)).toBe(0);
    expect(amountOf(discount({ type: "fixed", valueMinor: 500 }), 0)).toBe(0);
  });

  it("never returns a fraction", () => {
    for (const bps of [1, 333, 875, 1500, 9999]) {
      const d = discount({ type: "percentage", percentageBps: bps });
      for (const base of [1, 7, 99, 1234, 99999]) {
        expect(Number.isInteger(amountOf(d, base))).toBe(true);
      }
    }
  });
});

describe("statusOf", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const before = new Date("2026-01-01T00:00:00Z");
  const after = new Date("2026-12-31T00:00:00Z");

  it("is active inside its window", () => {
    expect(statusOf(discount({ type: "fixed", startsAt: before, endsAt: after }), now))
      .toBe("active");
  });

  it("is active with no window at all", () => {
    expect(statusOf(discount({ type: "fixed" }), now)).toBe("active");
  });

  it("is scheduled before it starts", () => {
    expect(statusOf(discount({ type: "fixed", startsAt: after }), now)).toBe("scheduled");
  });

  it("is expired after it ends", () => {
    expect(statusOf(discount({ type: "fixed", endsAt: before }), now)).toBe("expired");
  });

  it("reports disabled ahead of any date reasoning", () => {
    // A merchant who switched it off should see "disabled", not "expired" —
    // they are different problems with different fixes.
    const d = discount({ type: "fixed", enabled: false, endsAt: before });
    expect(statusOf(d, now)).toBe("disabled");
  });

  it("is active exactly at its boundaries", () => {
    expect(statusOf(discount({ type: "fixed", startsAt: now }), now)).toBe("active");
    expect(statusOf(discount({ type: "fixed", endsAt: now }), now)).toBe("active");
  });
});
