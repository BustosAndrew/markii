import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { membershipStatus } from "@/lib/commerce/memberships";
import { customerMemberships, customers, db, membershipTiers } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/customers/:id/memberships` (§18.9) — what this customer holds.
 *
 * Grants and revocations are §22 actions (`memberships.grant` / `revoke`).
 *
 * Every row carries a **derived** `status`; there is no stored one to disagree
 * with it. `revoked` and `expired` are reported separately because a merchant
 * looking at a complaint needs to know whether they took the access away or it
 * simply ran out.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { id } = await params;
    const customerId = Number(id);
    if (!Number.isInteger(customerId)) throw notFound("Customer");

    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), siteScope(orgId, customers.siteId)))
      .limit(1);
    if (!customer) throw notFound("Customer");

    const rows = await db
      .select({
        id: customerMemberships.id,
        tierId: customerMemberships.tierId,
        tierName: membershipTiers.name,
        tierHandle: membershipTiers.handle,
        startsAt: customerMemberships.startsAt,
        endsAt: customerMemberships.endsAt,
        revokedAt: customerMemberships.revokedAt,
        source: customerMemberships.source,
        orderId: customerMemberships.orderId,
        createdAt: customerMemberships.createdAt,
      })
      .from(customerMemberships)
      .innerJoin(membershipTiers, eq(membershipTiers.id, customerMemberships.tierId))
      .where(eq(customerMemberships.customerId, customer.id));

    const now = new Date();

    return NextResponse.json({
      items: rows.map((r) => ({
        id: r.id,
        tier: { id: r.tierId, name: r.tierName, handle: r.tierHandle },
        status: membershipStatus(r, now),
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        source: r.source,
        orderId: r.orderId,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
  { permission: "commerce.read" },
);
