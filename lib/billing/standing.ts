import type { Organization } from "../db";
import { describeDunning, dunningFor, inDunningStatus, type Dunning } from "./dunning";
import { statusGrantsPlan } from "./mirror";

/**
 * Whether an organization is in good standing with Markii — and if not, why.
 *
 * **Derived on every read, never stored.** The tempting shape is an
 * `account_status` column flipped by a nightly job, and it is wrong here for the
 * same reason it is wrong for memberships (D34): nothing in this codebase runs
 * on a clock that could flip it at the moment a trial lapses. The two crons that
 * exist bill and chase carts; neither sweeps accounts. A stored "trialing" would
 * go on granting a live storefront for however long it took someone to notice.
 *
 * Comparing a date to `now` cannot be stale.
 *
 * **This is separate from entitlements.** `entitlementsFor` answers *how much*
 * an org may do — how many storefronts, what threshold. This answers whether it
 * may do anything at all. A merchant out of standing keeps Starter entitlements
 * on paper; they simply cannot transact until they subscribe.
 */

export type AccountStanding =
  /** A paid (or Stripe-trialing) subscription. Nothing is gated. */
  | { state: "subscribed"; reason: string }
  /** Inside the free month. Full access, no card taken. */
  | {
      state: "trialing";
      reason: string;
      endsAt: Date;
      /** Whole days remaining, floored — 0 on the last day, never negative. */
      daysLeft: number;
    }
  /**
   * A renewal payment is failing (D10). What is held depends on how long it
   * has been — see `dunning.holds`. The storefront keeps serving until the
   * last rung, because a store taken down over a card is a churn event, not a
   * collection strategy.
   */
  | { state: "past_due"; reason: string; dunning: Dunning }
  /** The free month ran out with nothing bought. Storefronts and writes are held. */
  | { state: "expired"; reason: string; endedAt: Date }
  /**
   * No subscription and no trial date. Only reachable for a row written before
   * migration 0035 by a path that skipped the backfill, so it is treated as
   * **in good standing** rather than held: taking a live store offline over a
   * missing date would be Markii's bookkeeping error charged to a merchant.
   */
  | { state: "ungated"; reason: string };

export type StandingOrg = Pick<
  Organization,
  "stripeSubscriptionId" | "subscriptionStatus" | "freeTrialEndsAt" | "pastDueSince"
>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function accountStanding(org: StandingOrg, now: Date = new Date()): AccountStanding {
  /**
   * The subscription is checked **first and on its own terms**. A merchant who
   * pays is in standing whatever their trial date says — and leaving a stale
   * `free_trial_ends_at` on a paying org must never be able to hold their store.
   */
  /**
   * Dunning is checked **before** "grants", because `past_due` grants and
   * would otherwise read as plain `subscribed` — hiding the one fact the
   * banner exists to show. `unpaid` does not grant, and without this branch it
   * would fall through to the trial test and hold the storefront on Stripe's
   * give-up day rather than on the ladder's.
   */
  if (org.stripeSubscriptionId && inDunningStatus(org.subscriptionStatus)) {
    const dunning = dunningFor(org, now);
    if (dunning) {
      return {
        state: "past_due",
        reason: `Renewal payment failing since ${dunning.since.toISOString().slice(0, 10)}.`,
        dunning,
      };
    }
    // Past due with no episode start recorded: grace, until the mirror writes one.
    if (org.subscriptionStatus === "past_due") {
      return { state: "subscribed", reason: "A renewal payment failed and Stripe is retrying." };
    }
  }

  if (org.stripeSubscriptionId && statusGrantsPlan(org.subscriptionStatus ?? "")) {
    return { state: "subscribed", reason: "Subscription is active." };
  }

  if (!org.freeTrialEndsAt) {
    return {
      state: "ungated",
      reason: "No trial recorded for this organization, so nothing is held.",
    };
  }

  if (org.freeTrialEndsAt.getTime() > now.getTime()) {
    const daysLeft = Math.max(
      0,
      Math.floor((org.freeTrialEndsAt.getTime() - now.getTime()) / DAY_MS),
    );
    return {
      state: "trialing",
      reason:
        daysLeft === 0
          ? "Free trial ends today."
          : `Free trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
      endsAt: org.freeTrialEndsAt,
      daysLeft,
    };
  }

  return {
    state: "expired",
    reason: "The free trial has ended. Subscribe to bring the store back online.",
    endedAt: org.freeTrialEndsAt,
  };
}

/**
 * The single question every gate asks. `ungated` counts as good standing — see
 * the variant's note; a missing date is Markii's problem, not the merchant's.
 */
export function inGoodStanding(org: StandingOrg, now?: Date): boolean {
  return !writesHeld(accountStanding(org, now));
}

/**
 * The two questions every gate actually asks, answered from a standing rather
 * than from `state === "expired"` at each call site — which is how the dunning
 * ladder reaches every gate at once rather than the ones someone remembered.
 */
export function storefrontHeld(standing: AccountStanding): boolean {
  if (standing.state === "expired") return true;
  return standing.state === "past_due" && standing.dunning.holds.storefront;
}

export function writesHeld(standing: AccountStanding): boolean {
  if (standing.state === "expired") return true;
  return standing.state === "past_due" && standing.dunning.holds.writes;
}

export function growthHeld(standing: AccountStanding): boolean {
  if (writesHeld(standing)) return true;
  return standing.state === "past_due" && standing.dunning.holds.growth;
}

/**
 * The wire shape of a standing, written once so `/api/me` and
 * `/api/billing/subscription` cannot describe the same org differently — the
 * two used to carry their own copies of this ternary, which is how a new
 * variant would have reached one screen and not the other.
 */
export function serializeStanding(standing: AccountStanding) {
  switch (standing.state) {
    case "trialing":
      return {
        state: standing.state,
        message: standing.reason,
        endsAt: standing.endsAt.toISOString(),
        daysLeft: standing.daysLeft,
      };
    case "expired":
      return { state: standing.state, message: standing.reason, endedAt: standing.endedAt.toISOString() };
    case "past_due": {
      const d = standing.dunning;
      return {
        state: standing.state,
        message: describeDunning(d),
        dunning: {
          step: d.step,
          since: d.since.toISOString(),
          day: d.day,
          nextStep: d.nextStep,
          nextStepAt: d.nextStepAt?.toISOString() ?? null,
          holds: d.holds,
        },
      };
    }
    default:
      return { state: standing.state, message: standing.reason };
  }
}

/** One calendar month, which is what "a free month" means to a merchant. */
export function trialEndFrom(start: Date = new Date()): Date {
  const end = new Date(start.getTime());
  end.setMonth(end.getMonth() + 1);
  return end;
}
