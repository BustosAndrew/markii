import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { conflict } from "../api";
import {
  customerMemberships,
  db,
  membershipTiers,
  products,
  type DbHandle,
} from "../db";

/**
 * Membership gating (§18.9).
 *
 * A tier is an entitlement a store sells. A product may **require** one (only
 * members may view or buy it) and/or **grant** one (buying it confers the tier).
 *
 * Two rules shape everything here:
 *
 * 1. **Status is derived, never stored.** Nothing in this deployment schedules
 *    jobs, so a written `"expired"` would depend on a sweeper that does not
 *    exist — memberships would keep granting access after they lapsed. Every
 *    answer is computed from `startsAt` / `endsAt` / `revokedAt` at read time.
 * 2. **The gate resolves through the `customers` row, never the auth user.**
 *    D32 mitigation 1: staff and shoppers share one Supabase project, so
 *    "signed in" is not "entitled". Access requires a customer record *of this
 *    store* holding an active membership.
 */

export type MembershipStatus = "active" | "scheduled" | "expired" | "revoked";

export type MembershipRow = {
  startsAt: Date;
  endsAt: Date | null;
  revokedAt: Date | null;
};

/**
 * The effective status of one membership, at a moment.
 *
 * Order matters: a revoked membership is revoked even if its period is still
 * running, because the merchant's decision outranks the clock. `scheduled` is
 * reported rather than folded into `expired` — "not yet" and "no longer" send a
 * shopper to different places.
 */
export function membershipStatus(row: MembershipRow, now: Date = new Date()): MembershipStatus {
  if (row.revokedAt !== null && row.revokedAt <= now) return "revoked";
  if (row.startsAt > now) return "scheduled";
  if (row.endsAt !== null && row.endsAt <= now) return "expired";
  return "active";
}

export function isMembershipActive(row: MembershipRow, now: Date = new Date()): boolean {
  return membershipStatus(row, now) === "active";
}

/**
 * Extend a membership from whichever is later: now, or its current expiry.
 *
 * Renewing early must not cost the member the time they already paid for, and
 * renewing after a lapse must not back-date the new period into the gap — the
 * first is theft, the second grants access for days already missed.
 * A null `days` means no expiry, and a lifetime grant is never shortened back
 * into a finite one by a later purchase.
 */
export function extendedEndsAt(
  current: { endsAt: Date | null; revokedAt: Date | null } | null,
  days: number | null,
  now: Date = new Date(),
): Date | null {
  if (days === null) return null;
  // An existing lifetime membership outranks any finite extension.
  if (current && current.revokedAt === null && current.endsAt === null) return null;

  const base =
    current && current.revokedAt === null && current.endsAt !== null && current.endsAt > now
      ? current.endsAt
      : now;

  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

/** The tier ids this customer currently holds an active membership in. */
export async function activeTierIds(
  customerId: number,
  handle: DbHandle = db,
  now: Date = new Date(),
): Promise<Set<number>> {
  const rows = await handle
    .select({
      tierId: customerMemberships.tierId,
      startsAt: customerMemberships.startsAt,
      endsAt: customerMemberships.endsAt,
      revokedAt: customerMemberships.revokedAt,
    })
    .from(customerMemberships)
    .where(eq(customerMemberships.customerId, customerId));

  return new Set(rows.filter((r) => isMembershipActive(r, now)).map((r) => r.tierId));
}

export type GateSubject = { requiresTierId: number | null };

/**
 * Whether this viewer may see and buy a product.
 *
 * `customerId: null` is an anonymous shopper — refused for anything gated. That
 * is the whole point: before shopper accounts existed there was no one to check,
 * which is why gating could not be enforced at all.
 */
export async function canAccess(
  product: GateSubject,
  customerId: number | null,
  handle: DbHandle = db,
  now: Date = new Date(),
): Promise<boolean> {
  if (product.requiresTierId === null) return true;
  if (customerId === null) return false;
  const tiers = await activeTierIds(customerId, handle, now);
  return tiers.has(product.requiresTierId);
}

/**
 * Refuse a gated product the viewer does not hold the tier for.
 *
 * A `409` with the tier named, not a bare 403: the shopper's next step is to buy
 * the membership, and a refusal that does not say which one is unactionable.
 */
export async function assertAccess(
  product: GateSubject,
  customerId: number | null,
  handle: DbHandle = db,
): Promise<void> {
  if (await canAccess(product, customerId, handle)) return;

  const tier = product.requiresTierId
    ? (
        await handle
          .select({ name: membershipTiers.name })
          .from(membershipTiers)
          .where(eq(membershipTiers.id, product.requiresTierId))
          .limit(1)
      )[0]
    : undefined;

  throw conflict(
    tier
      ? `This product is available to ${tier.name} members. Sign in with a membership, or buy one first.`
      : "This product is available to members only.",
  );
}

/**
 * Filter a product list to what this viewer may access.
 *
 * One query for the whole list rather than one per product — a category page
 * with fifty products would otherwise issue fifty membership lookups.
 */
export async function accessibleProducts<T extends GateSubject>(
  products: T[],
  customerId: number | null,
  handle: DbHandle = db,
  now: Date = new Date(),
): Promise<T[]> {
  const gated = products.filter((p) => p.requiresTierId !== null);
  if (gated.length === 0) return products;
  if (customerId === null) return products.filter((p) => p.requiresTierId === null);

  const tiers = await activeTierIds(customerId, handle, now);
  return products.filter((p) => p.requiresTierId === null || tiers.has(p.requiresTierId));
}

/**
 * Refuse a cart containing anything the shopper may not access.
 *
 * Add-on product ids are checked alongside the line's own product: an add-on is
 * a product, so a members-only add-on attached to an open product would
 * otherwise be a way through the gate.
 */
export async function assertCartAccess(
  siteId: number,
  lines: { productId: number; addOns?: { productId: number }[] }[],
  customerId: number | null,
  handle: DbHandle = db,
): Promise<void> {
  const ids = [
    ...new Set(lines.flatMap((l) => [l.productId, ...(l.addOns ?? []).map((a) => a.productId)])),
  ];
  if (ids.length === 0) return;

  const gated = await handle
    .select({ id: products.id, name: products.name, requiresTierId: products.requiresTierId })
    .from(products)
    .where(and(inArray(products.id, ids), eq(products.siteId, siteId), isNotNull(products.requiresTierId)));

  if (gated.length === 0) return;

  const tiers = customerId === null ? new Set<number>() : await activeTierIds(customerId, handle);
  const blocked = gated.filter((p) => !tiers.has(p.requiresTierId as number));
  if (blocked.length === 0) return;

  throw conflict(
    `${blocked.map((p) => `"${p.name}"`).join(", ")} ${blocked.length === 1 ? "is" : "are"} ` +
      "available to members only, and your membership is not active. Remove " +
      `${blocked.length === 1 ? "it" : "them"} or renew before checking out.`,
  );
}

/**
 * Confer every membership this order's lines grant.
 *
 * Runs inside the order's own transaction — a paid order must never exist
 * without the access it was sold.
 *
 * Renewal is an **upsert that extends**, never a second row: buying a one-month
 * membership twice leaves one membership with two months on it. Two rows would
 * make "is this person a member?" a question with two answers.
 */
export async function grantMembershipsForOrder(
  handle: DbHandle,
  input: {
    orderId: number;
    siteId: number;
    customerId: number | null;
    lines: { productId: number }[];
  },
  now: Date = new Date(),
): Promise<{
  granted: { tierId: number; tierName: string; endsAt: string | null }[];
  unclaimed: { tierId: number; tierName: string }[];
}> {
  const ids = [...new Set(input.lines.map((l) => l.productId))];
  if (ids.length === 0) return { granted: [], unclaimed: [] };

  const granting = await handle
    .select({
      tierId: products.grantsTierId,
      durationDays: products.grantsDurationDays,
      tierName: membershipTiers.name,
    })
    .from(products)
    .innerJoin(membershipTiers, eq(membershipTiers.id, products.grantsTierId))
    .where(
      and(
        inArray(products.id, ids),
        eq(products.siteId, input.siteId),
        isNotNull(products.grantsTierId),
      ),
    );

  if (granting.length === 0) return { granted: [], unclaimed: [] };

  // A guest has no customer record to hold the entitlement. Reported, not
  // dropped — the caller writes it to the order timeline.
  if (input.customerId === null) {
    return {
      granted: [],
      unclaimed: granting.map((g) => ({ tierId: g.tierId as number, tierName: g.tierName })),
    };
  }

  const customerId = input.customerId;
  const granted: { tierId: number; tierName: string; endsAt: string | null }[] = [];

  for (const g of granting) {
    const tierId = g.tierId as number;

    const [current] = await handle
      .select({ endsAt: customerMemberships.endsAt, revokedAt: customerMemberships.revokedAt })
      .from(customerMemberships)
      .where(
        and(
          eq(customerMemberships.customerId, customerId),
          eq(customerMemberships.tierId, tierId),
        ),
      )
      .limit(1);

    const endsAt = extendedEndsAt(current ?? null, g.durationDays ?? null, now);

    await handle
      .insert(customerMemberships)
      .values({
        customerId,
        tierId,
        startsAt: now,
        endsAt,
        source: "purchase",
        orderId: input.orderId,
      })
      .onConflictDoUpdate({
        target: [customerMemberships.customerId, customerMemberships.tierId],
        set: {
          endsAt,
          /**
           * Paying again reinstates a revoked membership. The alternative —
           * taking the money and leaving it revoked — is the worse failure.
           */
          revokedAt: null,
          source: "purchase",
          orderId: input.orderId,
          updatedAt: now,
        },
      });

    granted.push({ tierId, tierName: g.tierName, endsAt: endsAt?.toISOString() ?? null });
  }

  return { granted, unclaimed: [] };
}

/**
 * Resolve one product's gate for a storefront page: the tier's name, and
 * whether the current viewer holds it.
 *
 * Kept separate from `canAccess` so a page can *say* which membership is
 * required. A locked page that will not name the thing to buy is a dead end.
 */
export async function membershipGateFor(
  siteId: number,
  requiresTierId: number,
): Promise<{ tierName: string; tierHandle: string; unlocked: boolean } | null> {
  const [tier] = await db
    .select({ id: membershipTiers.id, name: membershipTiers.name, handle: membershipTiers.handle })
    .from(membershipTiers)
    .where(and(eq(membershipTiers.id, requiresTierId), eq(membershipTiers.siteId, siteId)))
    .limit(1);
  if (!tier) return null;

  // Imported lazily: this module is pulled into order completion, and the auth
  // helper reaches for request-scoped cookies that do not exist there.
  const { currentCustomerId } = await import("../auth/shopper");
  const customerId = await currentCustomerId(siteId);
  const tiers = customerId === null ? new Set<number>() : await activeTierIds(customerId);

  return { tierName: tier.name, tierHandle: tier.handle, unlocked: tiers.has(tier.id) };
}

/** Tiers belonging to a store, for pickers and storefront copy. */
export async function tiersForSite(siteId: number, handle: DbHandle = db) {
  return handle
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.siteId, siteId))
    .orderBy(membershipTiers.name);
}

/**
 * Confirm every referenced tier belongs to this store.
 *
 * Tier ids arrive from merchant input on product writes, and a tier from another
 * store would gate this store's catalog on an entitlement its customers could
 * never hold — a cross-tenant reference that reads as a broken product rather
 * than as the tenancy error it is.
 */
export async function assertTiersOwnedBySite(
  tierIds: number[],
  siteId: number,
  handle: DbHandle = db,
): Promise<void> {
  const ids = [...new Set(tierIds)];
  if (ids.length === 0) return;

  const found = await handle
    .select({ id: membershipTiers.id })
    .from(membershipTiers)
    .where(and(inArray(membershipTiers.id, ids), eq(membershipTiers.siteId, siteId)));

  if (found.length !== ids.length) {
    throw conflict("That membership tier does not belong to this store.");
  }
}
