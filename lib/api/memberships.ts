import { invokeAction } from "./actions";
import { apiGet } from "./client";
import { callWhenLive } from "./planned";

const MEMBERSHIPS_SECTION = "API §18.9";

/** ✅ LIVE — tiers, customer memberships, and the five `memberships.*` actions. */
const MEMBERSHIPS_API_LIVE = true;

/**
 * Derived at read time, never stored (§18.9). Nothing schedules jobs here, so a
 * stored `"expired"` would keep claiming access after the date passed.
 *
 * `revoked` and `expired` are distinct on purpose: the merchant took it away, or
 * it ran out. `scheduled` has not started yet.
 */
export type MembershipStatus = "active" | "scheduled" | "expired" | "revoked";

export type MembershipTier = {
  id: number;
  siteId: number;
  name: string;
  /** Stable and not editable — it may already appear in storefront links. */
  handle: string;
  description: string | null;
  activeMemberCount: number;
  /** Everyone who ever held it, including lapsed and revoked. */
  totalMemberCount: number;
  /** Products only members can buy, and products that confer the tier. */
  gatedProductCount: number;
  grantingProductCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CustomerMembership = {
  id: number;
  tier: { id: number; name: string; handle: string };
  status: MembershipStatus;
  startsAt: string;
  endsAt: string | null;
  revokedAt: string | null;
  source: "purchase" | "manual";
  orderId: number | null;
  createdAt: string;
};

export function listMembershipTiers(query?: { siteId?: number }, init?: RequestInit) {
  return callWhenLive(MEMBERSHIPS_API_LIVE, MEMBERSHIPS_SECTION, () =>
    apiGet<{ items: MembershipTier[] }>("/api/memberships/tiers", query, init),
  );
}

export function listCustomerMemberships(customerId: number, init?: RequestInit) {
  return callWhenLive(MEMBERSHIPS_API_LIVE, MEMBERSHIPS_SECTION, () =>
    apiGet<{ items: CustomerMembership[] }>(
      `/api/customers/${customerId}/memberships`,
      undefined,
      init,
    ),
  );
}

export function createMembershipTier(
  body: { siteId: number; name: string; handle?: string; description?: string | null },
  init?: RequestInit,
) {
  return invokeAction<MembershipTier>("memberships.createTier", body, init);
}

export function updateMembershipTier(
  body: { tierId: number; name?: string; description?: string | null },
  init?: RequestInit,
) {
  return invokeAction<MembershipTier>("memberships.updateTier", body, init);
}

/**
 * **High risk, and not for the reason it looks.** `products.requires_tier_id` is
 * `on delete set null`, so deleting a tier ungates every product behind it —
 * paid-for content silently becomes public. The result reports how many, so a
 * confirmation can say it before the click rather than after.
 */
export function deleteMembershipTier(body: { tierId: number }, init?: RequestInit) {
  return invokeAction<{
    deleted: true;
    id: number;
    productsUngated: number;
    membershipsRemoved: number;
  }>("memberships.deleteTier", body, init);
}

/**
 * Grant or extend. Extending starts from the customer's current expiry, so
 * renewing early never forfeits unused time; omit `durationDays` for a
 * membership that does not expire.
 */
export function grantMembership(
  body: { customerId: number; tierId: number; durationDays?: number | null },
  init?: RequestInit,
) {
  return invokeAction<CustomerMembership>("memberships.grant", body, init);
}

/** Ends access now. The record survives, so the history still shows they held it. */
export function revokeMembership(
  body: { customerId: number; tierId: number },
  init?: RequestInit,
) {
  return invokeAction<CustomerMembership & { alreadyRevoked: boolean }>(
    "memberships.revoke",
    body,
    init,
  );
}
