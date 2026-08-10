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
 * **POST** accepts the same action for plain HTML forms (no JS on `/account`).
 * Form posts redirect with 303; JSON clients keep using DELETE.
 */

async function cancelRenewal(slug: string, id: string) {
  const site = await loadStore(slug);

  const membershipId = Number.parseInt(id, 10);
  if (!Number.isInteger(membershipId) || membershipId <= 0) {
    throw badRequest("membership id must be a number");
  }

  const customerId = await currentCustomerId(site.id);
  if (customerId === null) throw unauthorized("Sign in to manage your membership");

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

  if (membership.renewalCanceledAt) {
    return {
      canceled: true as const,
      alreadyCanceled: true as const,
      accessEndsAt: membership.endsAt?.toISOString() ?? null,
      message: "This membership was already set to stop renewing.",
      tierName: membership.tierName,
    };
  }

  const connection = await getIntegration(site.orgId, "stripe");
  if (connection?.status !== "connected" || !connection.config.accountId) {
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
  await db
    .update(customerMemberships)
    .set({ renewalCanceledAt: now, updatedAt: now })
    .where(eq(customerMemberships.id, membership.id));

  const accessEndsAt = stopped.currentPeriodEnd ?? membership.endsAt;

  return {
    canceled: true as const,
    alreadyCanceled: false as const,
    accessEndsAt: accessEndsAt?.toISOString() ?? null,
    message: accessEndsAt
      ? `"${membership.tierName}" will not renew. Access continues until ` +
        `${accessEndsAt.toISOString().slice(0, 10)}.`
      : `"${membership.tierName}" will not renew.`,
    tierName: membership.tierName,
  };
}

export const DELETE = handler(async (_req, { params }) => {
  const { site: slug, id } = await params;
  const result = await cancelRenewal(slug, id);
  if (result instanceof NextResponse) return result;
  return NextResponse.json(result);
});

/** Form-friendly cancel for the SSR account page (no client island). */
export const POST = handler(async (req, { params }) => {
  const { site: slug, id } = await params;
  const accept = req.headers.get("accept") ?? "";
  const isForm =
    (req.headers.get("content-type") ?? "").includes(
      "application/x-www-form-urlencoded",
    ) || !accept.includes("application/json");

  const result = await cancelRenewal(slug, id);

  if (result instanceof NextResponse) {
    if (!isForm) return result;
    const body = await result.json().catch(() => null);
    const message =
      typeof body?.error?.message === "string"
        ? body.error.message
        : "Could not cancel renewal.";
    return NextResponse.redirect(
      new URL(`/account?error=${encodeURIComponent(message)}`, req.url),
      303,
    );
  }

  if (isForm) {
    return NextResponse.redirect(
      new URL(`/account?notice=${encodeURIComponent(result.message)}`, req.url),
      303,
    );
  }
  return NextResponse.json(result);
});
