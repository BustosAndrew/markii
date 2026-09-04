import "server-only";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { siteHalted } from "../billing/standing-guard";
import { customerMemberships, customers, db, sites } from "../db";
import { getIntegration } from "../integrations";
import {
  pauseMembershipCollection,
  resumeMembershipCollection,
} from "./membership-billing";

/**
 * Keeping shoppers' recurring memberships in step with whether their store is
 * actually trading.
 *
 * **The point is to stop the charge before it happens.** Refusing to extend
 * `ends_at` when `invoice.paid` arrives is too late — Stripe has already moved
 * money on the merchant's own account and Markii is never in that flow (D4), so
 * the shopper is out of pocket for a period they cannot use. Pausing collection
 * means no invoice is ever charged, which is the only version of this that is
 * fair to the person holding the card.
 *
 * **One function for both directions, and it is idempotent.** Halting and
 * resuming are the same question asked at different times — "should this
 * subscription be billing right now?" — so a single pass that reconciles every
 * subscription against the current answer cannot drift the way a pair of
 * one-shot handlers would. Re-running it changes nothing.
 */

/** Bounded per run so a store with thousands of members cannot stall a webhook. */
const BATCH = 500;

export type CollectionSyncResult = {
  considered: number;
  paused: number;
  resumed: number;
  unchanged: number;
  failed: number;
  problems: string[];
};

type Row = { subscriptionId: string; siteId: number };

/**
 * Reconcile every live membership subscription in an org against its store's
 * current standing.
 *
 * Called from the two places standing can change: the platform
 * `customer.subscription.*` webhook (the merchant subscribed, or stopped) and
 * the site update route (the merchant paused or un-paused their own store).
 * Deliberately **not** called on a timer — there is no clock here, and a trial
 * that lapses overnight is caught by the next of those events or by the
 * `invoice.created` gate, which pauses at the moment Stripe tries to bill.
 */
export async function syncMembershipCollection(orgId: string): Promise<CollectionSyncResult> {
  const result: CollectionSyncResult = {
    considered: 0,
    paused: 0,
    resumed: 0,
    unchanged: 0,
    failed: 0,
    problems: [],
  };

  /**
   * No connected account means no subscriptions to hold — a merchant who never
   * connected Stripe cannot have sold a recurring membership.
   */
  const connection = await getIntegration(orgId, "stripe");
  const accountId = connection?.config?.accountId;
  if (connection?.status !== "connected" || !accountId) return result;

  const rows: Row[] = await db
    .select({
      subscriptionId: customerMemberships.stripeSubscriptionId,
      siteId: customers.siteId,
    })
    .from(customerMemberships)
    .innerJoin(customers, eq(customers.id, customerMemberships.customerId))
    .innerJoin(sites, eq(sites.id, customers.siteId))
    .where(
      and(
        eq(sites.orgId, orgId),
        isNotNull(customerMemberships.stripeSubscriptionId),
        /** A revoked membership is already over; its billing was stopped then. */
        isNull(customerMemberships.revokedAt),
      ),
    )
    .limit(BATCH) as Row[];

  result.considered = rows.length;
  if (rows.length === 0) return result;

  /** One halt lookup per store, not per member. */
  const haltBySite = new Map<number, boolean>();
  for (const siteId of new Set(rows.map((r) => r.siteId))) {
    haltBySite.set(siteId, (await siteHalted(siteId)).halted);
  }

  for (const row of rows) {
    const shouldPause = haltBySite.get(row.siteId) === true;
    try {
      if (shouldPause) {
        const res = await pauseMembershipCollection(accountId, row.subscriptionId);
        if (!res.ok) {
          result.failed += 1;
          result.problems.push(`${row.subscriptionId}: ${res.message}`);
        } else if (res.alreadyPaused) {
          result.unchanged += 1;
        } else {
          result.paused += 1;
        }
      } else {
        /**
         * Resume is sent unconditionally rather than after a read: clearing a
         * pause that is not set is a no-op at Stripe, and the extra round trip
         * per member would double the calls on the common path.
         */
        const res = await resumeMembershipCollection(accountId, row.subscriptionId);
        if (!res.ok) {
          result.failed += 1;
          result.problems.push(`${row.subscriptionId}: ${res.message}`);
        } else {
          result.resumed += 1;
        }
      }
    } catch (e) {
      result.failed += 1;
      result.problems.push(`${row.subscriptionId}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  return result;
}
