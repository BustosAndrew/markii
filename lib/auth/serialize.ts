import type { Organization, Staff } from "../db";
import { entitlementsFor } from "../plans";

/** Wire shapes for §16. Kept here so `/api/me`, `/api/org`, and staff routes cannot drift apart. */

export function serializeOrg(org: Organization) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    ownerId: org.ownerId,
    billingEmail: org.billingEmail,
    currency: org.currency,
    country: org.country,
    planId: org.planId,
    entitlements: entitlementsFor(org),
    createdAt: org.createdAt.toISOString(),
  };
}

export function serializeStaff(member: Staff) {
  return {
    id: member.id,
    orgId: member.orgId,
    // `userId` is null until an invitation is accepted. The contract types it as
    // a string, so surface the empty case rather than inventing an id.
    userId: member.userId ?? "",
    name: member.name,
    email: member.email,
    role: member.role,
    storeIds: member.storeIds,
    status: member.status,
    lastActiveAt: member.lastActiveAt?.toISOString() ?? null,
  };
}
