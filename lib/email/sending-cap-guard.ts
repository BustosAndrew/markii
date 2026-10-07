import "server-only";

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { statusGrantsPlan } from "../billing/mirror";
import { db, emailDeliveries, organizations } from "../db";
import { REPUTATION, sendingCapFor, type SendingCap } from "./sending-cap";

/**
 * The database half of the merchant sending cap (G12) — see `./sending-cap`
 * for the rules.
 */

/**
 * Statuses of mail that actually **left**. A bounce or complaint flips the
 * original `sent` row rather than adding one, so these three together count
 * each message exactly once.
 */
const LEFT_THE_BUILDING = ["sent", "bounced", "complained"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where the org stands against its cap right now, or null if that cannot be
 * worked out.
 *
 * **One query over one index** (`email_deliveries_org_idx`, on org and time):
 * the 24-hour count and the 30-day reputation are both filters over the same
 * range scan, so the cap costs a single round trip per send.
 *
 * **Fails open**, like every limiter here. A cap that cannot be read must not
 * stop a store's receipts — an unreadable table is Markii's fault, and this
 * is an abuse control rather than the thing standing between anyone and
 * anything they should not have.
 *
 * Concurrent sends can each see room and together overshoot by however many
 * raced. The overshoot is bounded by concurrency, not by an attacker, and an
 * exact cap would need a lock taken on every send for every merchant.
 */
export async function loadSendingCap(orgId: string, now: Date = new Date()): Promise<SendingCap | null> {
  try {
    const [org] = await db
      .select({
        createdAt: organizations.createdAt,
        stripeSubscriptionId: organizations.stripeSubscriptionId,
        subscriptionStatus: organizations.subscriptionStatus,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return null;

    const windowStart = new Date(now.getTime() - REPUTATION.windowDays * DAY_MS);
    const dayStart = new Date(now.getTime() - DAY_MS);

    const [counts] = await db
      .select({
        sent: sql<number>`count(*)::int`,
        bounced: sql<number>`(count(*) filter (where ${emailDeliveries.status} = 'bounced'))::int`,
        complained: sql<number>`(count(*) filter (where ${emailDeliveries.status} = 'complained'))::int`,
        sentLast24h: sql<number>`(count(*) filter (where ${emailDeliveries.createdAt} >= ${dayStart.toISOString()}))::int`,
      })
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.orgId, orgId),
          gte(emailDeliveries.createdAt, windowStart),
          inArray(emailDeliveries.status, [...LEFT_THE_BUILDING]),
        ),
      );

    return sendingCapFor({
      paying: Boolean(org.stripeSubscriptionId) && statusGrantsPlan(org.subscriptionStatus ?? ""),
      accountCreatedAt: org.createdAt,
      sentLast24h: Number(counts?.sentLast24h ?? 0),
      history: {
        sent: Number(counts?.sent ?? 0),
        bounced: Number(counts?.bounced ?? 0),
        complained: Number(counts?.complained ?? 0),
      },
      now,
    });
  } catch (e) {
    console.error("[email] sending cap unavailable, allowing send", e);
    return null;
  }
}
