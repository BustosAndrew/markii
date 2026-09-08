import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  missingEvents,
  REQUIRED_CONNECT_EVENTS,
  REQUIRED_PLATFORM_EVENTS,
  requiredEventsFor,
} from "./webhook-events";

/**
 * The manifest is a *second* list of event types — the route's `HANDLERS` map is
 * the first — and two lists of the same thing is exactly how a check stops
 * checking. So this asserts they agree.
 *
 * It reads the route as **text** rather than importing it. Importing pulls in
 * the database, the Stripe client and the whole action registry to answer a
 * question about which string keys exist, and a unit suite that is meant to run
 * in a second without a database should not pay that. The cost is that this
 * matches on source rather than on values, which is why the assertion is
 * written against the exact `"type":` key shape the map uses.
 */
const ROUTE = new URL("../../app/api/webhooks/stripe/route.ts", import.meta.url);
const routeSource = readFileSync(ROUTE, "utf8");

describe("required webhook events", () => {
  const all = [...REQUIRED_CONNECT_EVENTS, ...REQUIRED_PLATFORM_EVENTS];

  /**
   * A required event with no handler would be reported as correctly subscribed
   * while nothing acted on it — a green check over a dead wire.
   */
  it("every required event has a handler in the route", () => {
    for (const event of all) {
      expect(
        routeSource.includes(`"${event.type}":`),
        `${event.type} is required but has no handler in app/api/webhooks/stripe/route.ts`,
      ).toBe(true);
    }
  });

  it("names what breaks, not just the event", () => {
    for (const event of all) {
      expect(event.reason.length).toBeGreaterThan(30);
      // The reason is printed next to the type; repeating it reads as filler.
      expect(event.reason).not.toBe(event.type);
    }
  });

  it("lists no event twice within a rail", () => {
    for (const rail of ["connect", "platform"] as const) {
      const types = requiredEventsFor(rail).map((e) => e.type);
      expect(new Set(types).size).toBe(types.length);
    }
  });

  /**
   * `invoice.created` on the **Connect** rail is the one this manifest was
   * written for: without it a lapsed merchant's members keep being charged, and
   * nothing anywhere reports the absence.
   */
  it("requires invoice.created on the connect rail", () => {
    expect(REQUIRED_CONNECT_EVENTS.map((e) => e.type)).toContain("invoice.created");
  });

  describe("missingEvents", () => {
    it("reports what a subscription list does not cover", () => {
      const missing = missingEvents("connect", ["account.updated", "invoice.paid"]);
      expect(missing.map((e) => e.type)).toContain("invoice.created");
      expect(missing.map((e) => e.type)).not.toContain("account.updated");
    });

    it("treats Stripe's wildcard as covering everything", () => {
      expect(missingEvents("connect", ["*"])).toEqual([]);
      expect(missingEvents("platform", ["*"])).toEqual([]);
    });

    it("reports nothing when every required type is present", () => {
      const enabled = REQUIRED_PLATFORM_EVENTS.map((e) => e.type);
      expect(missingEvents("platform", enabled)).toEqual([]);
    });

    /** Extra types are noise, never a fault — a merchant may subscribe to more. */
    it("does not complain about events beyond the requirement", () => {
      const enabled = [...REQUIRED_CONNECT_EVENTS.map((e) => e.type), "customer.created"];
      expect(missingEvents("connect", enabled)).toEqual([]);
    });
  });
});
