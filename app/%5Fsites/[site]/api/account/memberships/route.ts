import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { handler, unauthorized } from "@/lib/api";
import { currentCustomerId } from "@/lib/auth/shopper";
import { membershipStatus } from "@/lib/commerce/memberships";
import { loadStore } from "@/lib/commerce/cart";
import { customerMemberships, db, membershipTiers } from "@/lib/db";

/**
 * `GET /_sites/{slug}/api/account/memberships` (§18.9) — what this shopper holds.
 *
 * Scoped to the **signed-in shopper on this store**, never to an id from the
 * request. A shopper is a customer of one merchant (`customers` is keyed by
 * `siteId`), so there is no cross-store view here by construction.
 *
 * **Status is computed per request, never read from a column.** There is no
 * stored status to go stale, which is the whole reason a membership that has
 * expired stops granting access without any job having to run.
 */
export const GET = handler(async (_req, { params }) => {
  const { site: slug } = await params;
  const site = await loadStore(slug);

  const customerId = await currentCustomerId(site.id);
  if (customerId === null) throw unauthorized("Sign in to see your memberships");

  const rows = await db
    .select({
      id: customerMemberships.id,
      tierId: customerMemberships.tierId,
      tierName: membershipTiers.name,
      startsAt: customerMemberships.startsAt,
      endsAt: customerMemberships.endsAt,
      revokedAt: customerMemberships.revokedAt,
      source: customerMemberships.source,
      stripeSubscriptionId: customerMemberships.stripeSubscriptionId,
      renewalCanceledAt: customerMemberships.renewalCanceledAt,
    })
    .from(customerMemberships)
    .innerJoin(membershipTiers, eq(membershipTiers.id, customerMemberships.tierId))
    .where(eq(customerMemberships.customerId, customerId))
    .orderBy(desc(customerMemberships.startsAt));

  const now = new Date();

  return NextResponse.json({
    memberships: rows.map((m) => {
      const renews = Boolean(m.stripeSubscriptionId) && m.renewalCanceledAt === null;
      return {
        id: m.id,
        tier: { id: m.tierId, name: m.tierName },
        status: membershipStatus(m, now),
        startsAt: m.startsAt.toISOString(),
        /** Null is a lifetime membership, not an unset field. */
        endsAt: m.endsAt?.toISOString() ?? null,
        source: m.source,
        /**
         * Whether this will charge again. A membership can be `active` and not
         * renew (cancelled, or a one-off purchase running out), and the two
         * facts answer different questions — "do I have access?" and "will I be
         * charged?". A screen that showed only the first would surprise someone
         * on the day their card was charged, or on the day it was not.
         */
        renews,
        renewalCanceledAt: m.renewalCanceledAt?.toISOString() ?? null,
        /** When access actually stops if nothing renews it. */
        accessEndsAt: m.endsAt?.toISOString() ?? null,
        /** Whether `DELETE …/{id}/renewal` would do anything. */
        cancellable: renews,
      };
    }),
  });
});
