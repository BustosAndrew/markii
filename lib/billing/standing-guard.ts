import "server-only";
import { eq } from "drizzle-orm";
import { ApiError } from "../api";
import { customerMemberships, customers, db, organizations, sites } from "../db";
import { accountStanding, type AccountStanding } from "./standing";

/**
 * Why a storefront is not transacting. Kept apart from `halted` itself because
 * the two causes are undone by different actions — the merchant un-pauses their
 * own store; only a subscription clears a billing hold.
 */
export type HaltCause = "paused" | "billing" | null;

/**
 * Whether a storefront must not transact, resolved from a site id.
 *
 * The same merged question `storefrontHalted` asks before rendering, for the
 * paths that never load a page: the digital-download redemption and the
 * membership-renewal webhook. Both are reached without a storefront request, so
 * neither can rely on the page-level check.
 */
export async function siteHalted(siteId: number): Promise<{ halted: boolean; cause: HaltCause }> {
  const [row] = await db
    .select({
      status: sites.status,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      subscriptionStatus: organizations.subscriptionStatus,
      freeTrialEndsAt: organizations.freeTrialEndsAt,
    })
    .from(sites)
    .innerJoin(organizations, eq(organizations.id, sites.orgId))
    .where(eq(sites.id, siteId))
    .limit(1);

  /** A missing join is Markii's bug, not a merchant's debt — never halt on it. */
  if (!row) return { halted: false, cause: null };
  if (row.status === "paused") return { halted: true, cause: "paused" };
  if (accountStanding(row).state === "expired") return { halted: true, cause: "billing" };
  return { halted: false, cause: null };
}

/** The store behind a shopper's recurring membership, for the renewal gate. */
export async function siteForMembershipSubscription(
  subscriptionId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ siteId: customers.siteId })
    .from(customerMemberships)
    .innerJoin(customers, eq(customers.id, customerMemberships.customerId))
    .where(eq(customerMemberships.stripeSubscriptionId, subscriptionId))
    .limit(1);
  return row?.siteId ?? null;
}

/**
 * The store a Markii customer belongs to.
 *
 * Needed because the **first** payment on a subscription has no membership row
 * yet — checkout deliberately writes none — so the renewal gate has nothing to
 * join through and must reach the store via the customer instead.
 */
export async function siteForCustomer(customerId: number): Promise<number | null> {
  const [row] = await db
    .select({ siteId: customers.siteId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return row?.siteId ?? null;
}

/**
 * The impure half of account standing — the lookup and the refusal.
 *
 * Split from `./standing` so the derivation itself stays a pure function of a
 * row and a clock: that is the part worth unit-testing, and it must not drag a
 * database into every test that touches it. Same split, and same reason, as
 * `price-catalog` against `stripe-billing`.
 */

/** Loads just enough of the org to decide, and caches nothing — see `accountStanding`. */
export async function standingFor(orgId: string): Promise<AccountStanding | null> {
  const [org] = await db
    .select({
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      subscriptionStatus: organizations.subscriptionStatus,
      freeTrialEndsAt: organizations.freeTrialEndsAt,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return null;
  return accountStanding(org);
}

/**
 * Refuses when the free month has run out and nothing was bought.
 *
 * **402, not 403.** The caller's permissions are fine and re-authenticating
 * cannot help; what is missing is a payment. A 403 would send the dashboard's
 * step-up modal after a second factor that would change nothing, and would tell
 * an agent it lacks authority when it lacks a subscription.
 *
 * A missing org is *not* treated as a hold: that is a bug or a race, and the
 * honest answer is to let the action's own `notFound` say so rather than tell a
 * merchant their trial ended.
 */
export async function assertAccountStanding(orgId: string, actionId: string): Promise<void> {
  const standing = await standingFor(orgId);
  if (!standing || standing.state !== "expired") return;

  throw new ApiError(
    "TRIAL_ENDED",
    402,
    `The free trial ended on ${standing.endedAt.toISOString().slice(0, 10)}, so "${actionId}" is on hold.`,
    {
      resolution:
        "Subscribe at /dashboard/settings/subscription to bring the store back online. " +
        "Your catalog, orders and customers are untouched and still readable.",
      standing: standing.state,
      endedAt: standing.endedAt.toISOString(),
    },
  );
}
