import { describe, expect, it } from "vitest";
import { DUNNING_LADDER, dunningFor, noticeDueOn } from "./dunning";
import {
  accountStanding,
  growthHeld,
  serializeStanding,
  storefrontHeld,
  writesHeld,
  type StandingOrg,
} from "./standing";

/**
 * The dunning ladder (D10) — pure. Which rung a day lands on, what each rung
 * holds, and that the holds reach standing's three questions. The wiring —
 * that a 402 actually comes back, that the storefront actually stops — is
 * `tests/integration/dunning.test.ts`.
 */

const DAY = 24 * 60 * 60_000;
const since = new Date("2026-09-01T09:00:00.000Z");
const at = (day: number, plus = 0) => new Date(since.getTime() + day * DAY + plus);

function org(over: Partial<StandingOrg> = {}): StandingOrg {
  return {
    stripeSubscriptionId: "sub_1",
    subscriptionStatus: "past_due",
    freeTrialEndsAt: new Date("2026-01-01T00:00:00.000Z"),
    pastDueSince: since,
    suspendedAt: null,
    suspendedReason: null,
    ...over,
  };
}

describe("dunningFor", () => {
  it("climbs the ladder on the decided days: 0, 7, 14, 30", () => {
    const steps = [0, 6, 7, 13, 14, 29, 30, 90].map((d) => dunningFor(org(), at(d))!.step);
    expect(steps).toEqual([
      "grace",
      "grace",
      "restricted_growth",
      "restricted_growth",
      "restricted_writes",
      "restricted_writes",
      "suspended",
      "suspended",
    ]);
  });

  it("holds more at each rung and never less", () => {
    const holds = DUNNING_LADDER.map((r) => dunningFor(org(), at(r.day))!.holds);
    expect(holds).toEqual([
      { growth: false, writes: false, storefront: false },
      { growth: true, writes: false, storefront: false },
      { growth: true, writes: true, storefront: false },
      { growth: true, writes: true, storefront: true },
    ]);
  });

  it("says when the next rung is, and that there is none at the top", () => {
    const grace = dunningFor(org(), at(2))!;
    expect(grace.nextStep).toBe("restricted_growth");
    expect(grace.nextStepAt).toEqual(at(7));
    expect(dunningFor(org(), at(31))!.nextStep).toBeNull();
    expect(dunningFor(org(), at(31))!.nextStepAt).toBeNull();
  });

  it("floors the day, so the rung changes at the moment and not an hour early", () => {
    expect(dunningFor(org(), at(7, -1))!.step).toBe("grace");
    expect(dunningFor(org(), at(7))!.step).toBe("restricted_growth");
  });

  /**
   * `unpaid` is Stripe giving up — a later point on the same clock, not a new
   * one. The plan drops to the floor there (entitlements), but standing stays
   * on the ladder: the storefront runs to day 30 whichever status Stripe uses.
   */
  it("keeps the same clock through unpaid", () => {
    const d = dunningFor(org({ subscriptionStatus: "unpaid" }), at(20))!;
    expect(d.step).toBe("restricted_writes");
    expect(d.holds.storefront).toBe(false);
  });

  it("is null when not in dunning, and null for past_due with no episode start", () => {
    expect(dunningFor(org({ subscriptionStatus: "active" }), at(5))).toBeNull();
    expect(dunningFor(org({ pastDueSince: null }), at(5))).toBeNull();
  });
});

describe("noticeDueOn", () => {
  it("sends day 0 through the grace week, day 7 until the eve, and day 13 that day only", () => {
    expect([0, 3, 6].map(noticeDueOn)).toEqual([0, 0, 0]);
    expect([7, 9, 12].map(noticeDueOn)).toEqual([7, 7, 7]);
    expect(noticeDueOn(13)).toBe(13);
    // "Changes go on hold tomorrow" would be false on day 15.
    expect([14, 15, 40].map(noticeDueOn)).toEqual([null, null, null]);
  });
});

describe("accountStanding in dunning", () => {
  it("reports past_due ahead of subscribed, so the banner is not hidden behind a grant", () => {
    const s = accountStanding(org(), at(1));
    expect(s.state).toBe("past_due");
  });

  /**
   * Without this, `unpaid` — which does not grant — would fall through to the
   * trial test and hold the storefront on Stripe's give-up day rather than the
   * ladder's day 30.
   */
  it("keeps an unpaid subscription on the ladder rather than treating it as an expired trial", () => {
    const s = accountStanding(org({ subscriptionStatus: "unpaid" }), at(20));
    expect(s.state).toBe("past_due");
    expect(storefrontHeld(s)).toBe(false);
    expect(writesHeld(s)).toBe(true);
  });

  it("answers the three gate questions from the rung", () => {
    const grace = accountStanding(org(), at(1));
    expect([growthHeld(grace), writesHeld(grace), storefrontHeld(grace)]).toEqual([false, false, false]);
    const growth = accountStanding(org(), at(8));
    expect([growthHeld(growth), writesHeld(growth), storefrontHeld(growth)]).toEqual([true, false, false]);
    const writes = accountStanding(org(), at(15));
    expect([growthHeld(writes), writesHeld(writes), storefrontHeld(writes)]).toEqual([true, true, false]);
    const suspended = accountStanding(org(), at(31));
    expect([growthHeld(suspended), writesHeld(suspended), storefrontHeld(suspended)]).toEqual([true, true, true]);
  });

  it("treats past_due with no recorded start as plain grace", () => {
    const s = accountStanding(org({ pastDueSince: null }), at(40));
    expect(s.state).toBe("subscribed");
    expect(writesHeld(s)).toBe(false);
  });

  it("serializes the rung, the dates and the holds for the wire", () => {
    const wire = serializeStanding(accountStanding(org(), at(8)));
    expect(wire).toMatchObject({
      state: "past_due",
      dunning: {
        step: "restricted_growth",
        since: since.toISOString(),
        day: 8,
        nextStep: "restricted_writes",
        nextStepAt: at(14).toISOString(),
        holds: { growth: true, writes: false, storefront: false },
      },
    });
    expect(typeof (wire as { message: string }).message).toBe("string");
  });
});
