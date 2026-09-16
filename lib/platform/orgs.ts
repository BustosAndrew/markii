import "server-only";

import { eq, or } from "drizzle-orm";
import { notFound } from "@/lib/api";
import { db, organizations, sites } from "@/lib/db";
import { accountStanding, serializeStanding } from "@/lib/billing/standing";

/**
 * What an operator sees of a merchant's org (G12) — enough to act on a
 * sign-up-review line and to confirm the action took, and no more.
 *
 * **By id or slug**, because the digest names the slug and the audit row names
 * the id, and an operator arriving from either should not need a lookup.
 * Slugs are unique (`organizations_slug_uq`) so the two cannot collide with a
 * real row, only with each other, and an id is never shaped like a slug.
 *
 * Deliberately not the org's full row: the operator's job here is standing
 * and suspension. Billing address, Stripe ids and entitlements are the
 * merchant's business and their own dashboard's.
 */
export async function platformOrgView(idOrSlug: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(or(eq(organizations.id, idOrSlug), eq(organizations.slug, idOrSlug)))
    .limit(1);
  if (!org) throw notFound("Organization");

  const stores = await db
    .select({ id: sites.id, slug: sites.slug, name: sites.name, status: sites.status })
    .from(sites)
    .where(eq(sites.orgId, org.id));

  const standing = accountStanding(org);

  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    billingEmail: org.billingEmail,
    createdAt: org.createdAt.toISOString(),
    planId: org.planId,
    standing: serializeStanding(standing),
    /**
     * The reason, as recorded. `standing.message` above is the merchant's
     * "contact support" copy; the merchant reads the reason in their audit log.
     */
    suspension: org.suspendedAt
      ? {
          since: org.suspendedAt.toISOString(),
          reason: org.suspendedReason,
          by: org.suspendedBy,
        }
      : null,
    stores,
  };
}
