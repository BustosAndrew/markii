import { describe, expect, it } from "vitest";
import {
  accountStanding,
  growthHeld,
  inGoodStanding,
  serializeStanding,
  storefrontHeld,
  trialEndFrom,
  writesHeld,
  type StandingOrg,
} from "./standing";

/**
 * Account standing decides whether a merchant's storefront serves at all, which
 * makes it the highest-consequence pure function in the billing code: wrong in
 * one direction it takes a paying merchant's store offline, wrong in the other
 * it gives the product away.
 */

const NOW = new Date("2026-09-04T12:00:00.000Z");

function org(over: Partial<StandingOrg> = {}): StandingOrg {
  return {
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    freeTrialEndsAt: null,
    pastDueSince: null,
    suspendedAt: null,
    suspendedReason: null,
    ...over,
  };
}

describe("accountStanding", () => {
  it("puts a paying subscription in standing whatever the trial says", () => {
    /**
     * The ordering that matters most: a stale `free_trial_ends_at` left on a
     * paying org must never be able to dark-site them.
     */
    const s = accountStanding(
      org({
        stripeSubscriptionId: "sub_1",
        subscriptionStatus: "active",
        freeTrialEndsAt: new Date("2020-01-01T00:00:00.000Z"),
      }),
      NOW,
    );
    expect(s.state).toBe("subscribed");
  });

  it("keeps a past_due merchant online while Stripe retries", () => {
    /**
     * Same reasoning as `statusGrantsPlan`: a card that expired overnight is not
     * a reason to take a working store down before dunning has run.
     */
    const s = accountStanding(
      org({ stripeSubscriptionId: "sub_1", subscriptionStatus: "past_due" }),
      NOW,
    );
    expect(s.state).toBe("subscribed");
  });

  it("does not count an unpaid subscription as standing", () => {
    /**
     * `incomplete` is a subscription whose first invoice was never paid. Reading
     * the id alone would hand out the product for the price of starting a
     * checkout and abandoning it.
     */
    const s = accountStanding(
      org({
        stripeSubscriptionId: "sub_1",
        subscriptionStatus: "incomplete",
        freeTrialEndsAt: new Date("2026-09-20T00:00:00.000Z"),
      }),
      NOW,
    );
    expect(s.state).toBe("trialing");
  });

  it("is trialing before the date and expired after it", () => {
    const before = accountStanding(
      org({ freeTrialEndsAt: new Date("2026-09-06T12:00:00.000Z") }),
      NOW,
    );
    expect(before).toMatchObject({ state: "trialing", daysLeft: 2 });

    const after = accountStanding(
      org({ freeTrialEndsAt: new Date("2026-09-03T12:00:00.000Z") }),
      NOW,
    );
    expect(after.state).toBe("expired");
  });

  it("reports 0 days left on the final day rather than going negative", () => {
    const s = accountStanding(
      org({ freeTrialEndsAt: new Date("2026-09-04T23:59:00.000Z") }),
      NOW,
    );
    expect(s).toMatchObject({ state: "trialing", daysLeft: 0 });
    if (s.state === "trialing") expect(s.reason).toContain("today");
  });

  /**
   * The safety valve. A row with no trial date can only come from a path that
   * predates migration 0035 or skipped its backfill — Markii's bookkeeping
   * error, and taking a live store offline over it would charge that error to
   * the merchant.
   */
  it("does not hold an org that has no trial date recorded", () => {
    const s = accountStanding(org(), NOW);
    expect(s.state).toBe("ungated");
    expect(inGoodStanding(org(), NOW)).toBe(true);
  });

  it("treats only expired as out of standing", () => {
    expect(inGoodStanding(org({ freeTrialEndsAt: new Date("2026-09-03T00:00:00Z") }), NOW)).toBe(
      false,
    );
    expect(inGoodStanding(org({ freeTrialEndsAt: new Date("2026-09-05T00:00:00Z") }), NOW)).toBe(
      true,
    );
  });
});

describe("trialEndFrom", () => {
  it("is one calendar month, which is what a merchant was promised", () => {
    expect(trialEndFrom(new Date("2026-09-04T12:00:00.000Z")).toISOString()).toBe(
      "2026-10-04T12:00:00.000Z",
    );
  });

  /**
   * January 31st + one month has no 31st to land on. JS rolls into March, which
   * is *longer* than a month — acceptable, because the error favours the
   * merchant. Pinned so a future "fix" has to be a deliberate decision about
   * which way to round, not an accident.
   */
  it("rolls a month-end start forward rather than truncating it", () => {
    const end = trialEndFrom(new Date("2026-01-31T00:00:00.000Z"));
    expect(end.toISOString().slice(0, 10)).toBe("2026-03-03");
  });
});

describe("suspended (G12)", () => {
  const since = new Date("2026-09-10T00:00:00.000Z");

  /**
   * The ordering that matters: a paying merchant is normally in standing
   * whatever else the row says. A suspension is the one thing that outranks
   * that, because it is Markii's decision and paying does not lift it.
   */
  it("outranks a paying subscription", () => {
    const s = accountStanding(
      org({
        stripeSubscriptionId: "sub_1",
        subscriptionStatus: "active",
        suspendedAt: since,
        suspendedReason: "review",
      }),
      NOW,
    );
    expect(s.state).toBe("suspended");
    if (s.state === "suspended") expect(s.since).toBe(since);
  });

  it("holds storefront, writes and growth all at once", () => {
    const s = accountStanding(org({ suspendedAt: since }), NOW);
    expect(storefrontHeld(s)).toBe(true);
    expect(writesHeld(s)).toBe(true);
    expect(growthHeld(s)).toBe(true);
    expect(inGoodStanding(org({ suspendedAt: since }), NOW)).toBe(false);
  });

  /** The timestamp records when; it is not a schedule. */
  it("is suspended even if the timestamp is in the future", () => {
    const s = accountStanding(org({ suspendedAt: new Date("2030-01-01T00:00:00Z") }), NOW);
    expect(s.state).toBe("suspended");
  });

  /**
   * The standing payload says what to do; the grounds live in the audit log.
   * Pinned so `/api/me` does not start repeating a free-text note on every
   * page load.
   */
  it("carries the support message, not the reason", () => {
    const s = accountStanding(org({ suspendedAt: since, suspendedReason: "40 sign-ups from throwaway.example" }), NOW);
    const wire = serializeStanding(s) as { state: string; message: string; since?: string };
    expect(wire.state).toBe("suspended");
    expect(wire.since).toBe(since.toISOString());
    expect(JSON.stringify(wire)).not.toContain("throwaway");
    expect(wire.message).toMatch(/support/i);
  });
});
