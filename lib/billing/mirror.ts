import { eq } from "drizzle-orm";
import type { DbHandle, PlanId, SubscriptionStatusValue } from "../db";
import { organizations, SUBSCRIPTION_STATUSES } from "../db";
import type { SubscriptionSnapshot } from "./stripe-billing";

/**
 * Mirroring a Stripe subscription onto the organization row (§17).
 *
 * **Stripe is the source of truth; these columns are a cache of it.** They exist
 * because every gate in the product reads `organizations.plan_id` synchronously
 * and cannot call Stripe on each request. The mirror is written from exactly two
 * places — the plan-change action and the `customer.subscription.*` webhook —
 * and both come through this function so they cannot derive different answers
 * from the same event. That mattered enough to be a module: the action writes
 * optimistically from Stripe's API response, the webhook writes authoritatively
 * from the event, and if those two disagreed about what "past_due" grants, a
 * merchant's entitlements would depend on which arrived last.
 */

/**
 * The floor an organization falls back to when nothing is being paid for.
 *
 * `starter` is the *lowest* plan, not a free one — `docs/PRICING.md` §3 defines
 * no free tier. So this is the conservative choice rather than an obviously
 * correct one: it grants the smallest entitlement set that exists (1 storefront)
 * instead of inventing a `free` plan the pricing doc never described. If a free
 * tier is ever defined, this constant is the one place that changes.
 */
export const FLOOR_PLAN: PlanId = "starter";

/**
 * The status vocabulary lives on the schema (`SUBSCRIPTION_STATUSES`) because
 * the column's enum and this guard must never disagree — a status Stripe sends,
 * this accepts, and the column rejects would fail the write at the moment a
 * merchant's billing state changed.
 */
export type SubscriptionStatus = SubscriptionStatusValue;

export function isSubscriptionStatus(s: string): s is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(s);
}

/**
 * Whether a status entitles the org to the plan it is subscribed to.
 *
 * **`past_due` still grants**, deliberately. A renewal can fail on an expired
 * card while the merchant is asleep, and Stripe's dunning retries it over days;
 * revoking on the first decline would take a working storefront offline over a
 * card that is about to succeed. `unpaid` is where Stripe gives up, and that is
 * where access stops.
 *
 * **`incomplete` does not grant**, equally deliberately. That is a subscription
 * whose first invoice was never paid — treating it as active is precisely the
 * free-upgrade hole the old `503` was protecting: a higher threshold and more
 * storefronts with nothing sold.
 */
export function statusGrantsPlan(status: string): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

export type MirrorResult = {
  /** What the org's plan ended up as — the subscribed plan, or the floor. */
  planId: PlanId;
  status: SubscriptionStatus;
  /** True when the plan actually moved, so callers can record a diff worth reading. */
  planChanged: boolean;
};

/**
 * Writes a snapshot onto the org.
 *
 * `guardAgainstStale` is for the webhook, not the action. Stripe redelivers for
 * three days, so an event for a subscription the org has since replaced must not
 * overwrite the current one. The action skips the guard because it *is* the
 * thing that just changed the subscription — it would otherwise refuse its own
 * write.
 */
export async function mirrorSubscription(
  db: DbHandle,
  orgId: string,
  snapshot: SubscriptionSnapshot,
  opts: { guardAgainstStale?: boolean } = {},
): Promise<MirrorResult | { stale: true; reason: string }> {
  const [org] = await db
    .select({ planId: organizations.planId, subscriptionId: organizations.stripeSubscriptionId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return { stale: true, reason: `No organization ${orgId}.` };

  if (
    opts.guardAgainstStale &&
    org.subscriptionId != null &&
    org.subscriptionId !== snapshot.subscriptionId
  ) {
    return {
      stale: true,
      reason:
        `Event is for subscription ${snapshot.subscriptionId} but the org is now on ` +
        `${org.subscriptionId}; ignoring rather than reverting the current one.`,
    };
  }

  /**
   * **An unrecognised status changes nothing.** The tempting shortcut is to
   * coerce it to `incomplete`, but `incomplete` does not grant the plan — so the
   * day Stripe adds a status to its vocabulary, every merchant carrying it would
   * be quietly downgraded to the floor plan by a deployment that shipped no such
   * decision.
   *
   * Refusing instead surfaces it: the webhook records the event as `ignored`
   * with this reason (the table requires one), the merchant keeps what they are
   * paying for, and somebody reads it and adds the status deliberately.
   */
  if (!isSubscriptionStatus(snapshot.status)) {
    return {
      stale: true,
      reason:
        `Stripe sent subscription status "${snapshot.status}", which this deployment does not ` +
        "recognise. Entitlements left unchanged rather than downgraded — add it to " +
        "SUBSCRIPTION_STATUSES and decide whether it grants the plan.",
    };
  }
  const status: SubscriptionStatus = snapshot.status;

  /**
   * The plan is taken from the *price's lookup key*, never from what the caller
   * asked for. A plan change that half-applied then reports what Stripe has,
   * which is the number the merchant will actually be billed.
   *
   * A subscription whose price carries no recognisable lookup key leaves the
   * plan alone rather than dropping the merchant to the floor — that is a
   * misconfigured Price in Stripe, and taking storefronts away is the wrong
   * response to Markii's own configuration error.
   */
  const grants = statusGrantsPlan(status);
  const nextPlan: PlanId = grants ? (snapshot.planId ?? org.planId) : FLOOR_PLAN;

  await db
    .update(organizations)
    .set({
      planId: nextPlan,
      stripeCustomerId: snapshot.customerId || undefined,
      stripeSubscriptionId: snapshot.subscriptionId,
      subscriptionStatus: status,
      subscriptionInterval: snapshot.interval,
      currentPeriodStart: snapshot.currentPeriodStart,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      trialEndsAt: snapshot.trialEndsAt,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId));

  return { planId: nextPlan, status, planChanged: nextPlan !== org.planId };
}

/**
 * Applies a terminal cancellation: the subscription is gone, not merely flagged.
 *
 * Separate from `mirrorSubscription` because `customer.subscription.deleted`
 * means the object no longer exists — keeping its id would leave the org
 * pointing at something Stripe will 404 on, and the next plan change would try
 * to modify it instead of creating a new one.
 */
export async function mirrorCancellation(
  db: DbHandle,
  orgId: string,
  subscriptionId: string,
): Promise<MirrorResult | { stale: true; reason: string }> {
  const [org] = await db
    .select({ planId: organizations.planId, subscriptionId: organizations.stripeSubscriptionId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return { stale: true, reason: `No organization ${orgId}.` };

  if (org.subscriptionId && org.subscriptionId !== subscriptionId) {
    return {
      stale: true,
      reason:
        `Deletion is for ${subscriptionId} but the org is now on ${org.subscriptionId}; ` +
        "ignoring so a redelivered cancellation cannot revoke a replacement subscription.",
    };
  }

  await db
    .update(organizations)
    .set({
      planId: FLOOR_PLAN,
      stripeSubscriptionId: null,
      subscriptionStatus: "canceled",
      subscriptionInterval: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId));

  return { planId: FLOOR_PLAN, status: "canceled", planChanged: org.planId !== FLOOR_PLAN };
}
