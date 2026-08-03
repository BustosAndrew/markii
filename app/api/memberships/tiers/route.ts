import { and, count, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { customerMemberships, db, membershipTiers, products } from "@/lib/db";
import { isMembershipActive } from "@/lib/commerce/memberships";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/memberships/tiers` (§18.9) — the store's membership tiers.
 *
 * Writes are §22 actions (`memberships.createTier` / `updateTier` /
 * `deleteTier`), not methods here.
 *
 * **Member counts are computed, never stored.** A membership expires by the
 * clock and nothing schedules a job to notice, so a cached count would drift
 * upward forever — and a merchant reads it as "people who can get in right now".
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const siteId = intParam(sp, "siteId");

    const conds = [siteScope(orgId, membershipTiers.siteId)];
    if (siteId != null) conds.push(eq(membershipTiers.siteId, siteId));

    const tiers = await db
      .select()
      .from(membershipTiers)
      .where(and(...conds))
      .orderBy(membershipTiers.name);

    if (tiers.length === 0) return NextResponse.json({ items: [] });

    const ids = tiers.map((t) => t.id);

    const memberships = await db
      .select({
        tierId: customerMemberships.tierId,
        startsAt: customerMemberships.startsAt,
        endsAt: customerMemberships.endsAt,
        revokedAt: customerMemberships.revokedAt,
      })
      .from(customerMemberships)
      .where(inArray(customerMemberships.tierId, ids));

    const gating = await db
      .select({ tierId: products.requiresTierId, n: count() })
      .from(products)
      .where(inArray(products.requiresTierId, ids))
      .groupBy(products.requiresTierId);

    const granting = await db
      .select({ tierId: products.grantsTierId, n: count() })
      .from(products)
      .where(inArray(products.grantsTierId, ids))
      .groupBy(products.grantsTierId);

    const now = new Date();
    const activeByTier = new Map<number, number>();
    const totalByTier = new Map<number, number>();
    for (const m of memberships) {
      totalByTier.set(m.tierId, (totalByTier.get(m.tierId) ?? 0) + 1);
      if (isMembershipActive(m, now)) {
        activeByTier.set(m.tierId, (activeByTier.get(m.tierId) ?? 0) + 1);
      }
    }

    return NextResponse.json({
      items: tiers.map((t) => ({
        id: t.id,
        siteId: t.siteId,
        name: t.name,
        handle: t.handle,
        description: t.description,
        activeMemberCount: activeByTier.get(t.id) ?? 0,
        /** Everyone who has ever held it, including lapsed and revoked. */
        totalMemberCount: totalByTier.get(t.id) ?? 0,
        /** How much of the catalog this tier unlocks, and how it is sold. */
        gatedProductCount: gating.find((g) => g.tierId === t.id)?.n ?? 0,
        grantingProductCount: granting.find((g) => g.tierId === t.id)?.n ?? 0,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
    });
  },
  { permission: "commerce.read" },
);
