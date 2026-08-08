import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, handler, notFound, unauthorized } from "@/lib/api";
import { currentCustomerId } from "@/lib/auth/shopper";
import { loadStore } from "@/lib/commerce/cart";
import { cancelMembershipRenewal } from "@/lib/commerce/membership-billing";
import { customerMemberships, customers, db, membershipTiers } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";

/**
 * `DELETE /_sites/{slug}/api/account/memberships/{id}/renewal` (§18.9) — the
 * member stops their own subscription.
 *
 * **A recurring charge a shopper cannot stop themselves is not acceptable**, and
 * until this existed that was the state: `cancelMembershipRenewal` sat in
 * `lib/` with nothing calling it, so a member's only route out was emailing the
 * merchant.
 *
 * **It cancels the renewal, not the membership.** Access runs to `endsAt` —
 * they paid for the period, and ending it early would delete time they bought.
 * That is the same rule Markii's own subscription cancellation follows, and it
 * is why nothing here touches `revokedAt`: *"I cancelled"* and *"the merchant
 * removed me"* are different facts, kept in different columns.
 *
 * The membership id comes from the URL, so it is checked against the signed-in
 * shopper **and** against this store before anything happens. A membership that
 * is not theirs answers `404`, not `403` — "forbidden" would confirm it exists.
 */
export const DELETE = handler(async (_req, { params }) => {
  const { site: slug, id } = await params;
  const site = await loadStore(slug);

  const membershipId = Number.parseInt(id, 10);
  if (!Number.isInteger(membershipId) || membershipId <= 0) {
    throw badRequest("membership id must be a number");
  }

  const customerId = await currentCustomerId(site.id);
  if (customerId === null) throw unauthorized("Sign in to manage your membership");

  /**
   * Scoped on **both** the customer and the site. The customer check alone would
   * be enough today, since a customer belongs to one store — but relying on that
   * leaves the boundary resting on an invariant enforced somewhere else, and
   * this is a route that stops a payment.
   */
  const [membership] = await db
    .select({
      id: customerMemberships.id,
      tierName: membershipTiers.name,
      endsAt: customerMemberships.endsAt,
      subscriptionId: customerMemberships.stripeSubscriptionId,
      renewalCanceledAt: customerMemberships.renewalCanceledAt,
    })
    .from(customerMemberships)
    .innerJoin(customers, eq(customers.id, customerMemberships.customerId))
    .innerJoin(membershipTiers, eq(membershipTiers.id, customerMemberships.tierId))
    .where(
      and(
        eq(customerMemberships.id, membershipId),
        eq(customerMemberships.customerId, customerId),
        eq(customers.siteId, site.id),
      ),
    )
    .limit(1);

  if (!membership) throw notFound("Membership");

  if (!membership.subscriptionId) {
    throw badRequest(
      `"${membership.tierName}" does not renew — it was a one-off purchase, and it simply ends ` +
        "when its period does. There is nothing to cancel.",
    );
  }

  /**
   * Already cancelled. Reported as success rather than an error: the member
   * asked for this to stop renewing and it is not renewing. A second click, or
   * a retried request, must not read as a failure.
   */
  if (membership.renewalCanceledAt) {
    return NextResponse.json({
      canceled: true,
      alreadyCanceled: true,
      accessEndsAt: membership.endsAt?.toISOString() ?? null,
      message: "This membership was already set to stop renewing.",
    });
  }

  const connection = await getIntegration(site.orgId, "stripe");
  if (connection?.status !== "connected" || !connection.config.accountId) {
    /**
     * The subscription lives on the merchant's account, so without the
     * connection there is no way to stop it. **Refused rather than marked
     * cancelled locally** — writing `renewalCanceledAt` here would tell the
     * member they had stopped a charge that Stripe would keep taking.
     */
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: "This membership cannot be cancelled here right now.",
          details: {
            resolution: "Contact the store owner — their payment connection is unavailable.",
          },
        },
      },
      { status: 409 },
    );
  }

  const stopped = await cancelMembershipRenewal(
    connection.config.accountId,
    membership.subscriptionId,
  );
  if (!stopped.ok) {
    /**
     * Stripe refused, so the subscription is still live. The local row is left
     * untouched for the same reason as above: the member must not be told a
     * charge has stopped while it has not.
     */
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: "The membership could not be cancelled — the payment provider refused.",
          details: { reason: stopped.message },
        },
      },
      { status: 409 },
    );
  }

  const now = new Date();
  /**
   * Written **after** Stripe confirms, so the column only ever records a
   * cancellation that really happened. `endsAt` is left alone — Stripe's period
   * end is what the member already paid for, and the existing value is what the
   * last `invoice.paid` set it to.
   */
  await db
    .update(customerMemberships)
    .set({ renewalCanceledAt: now, updatedAt: now })
    .where(eq(customerMemberships.id, membership.id));

  const accessEndsAt = stopped.currentPeriodEnd ?? membership.endsAt;

  return NextResponse.json({
    canceled: true,
    alreadyCanceled: false,
    /** Stated plainly, because "when do I lose access?" is the only question here. */
    accessEndsAt: accessEndsAt?.toISOString() ?? null,
    message: accessEndsAt
      ? `"${membership.tierName}" will not renew. Access continues until ` +
        `${accessEndsAt.toISOString().slice(0, 10)}.`
      : `"${membership.tierName}" will not renew.`,
  });
});
