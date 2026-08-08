import "server-only";

import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { conflict } from "../api";
import {
  customerMemberships,
  customers,
  db,
  membershipTiers,
  products,
  sites,
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
 * A recurring membership in the cart, if there is one.
 *
 * **A subscription cannot share a basket, and this is what enforces it.** Stripe
 * settles a subscription through its own invoice, not through the one-off
 * PaymentIntent the rest of checkout uses, so a cart holding both would need two
 * payments for one basket: two authorisations on the shopper's card, two things
 * that can fail independently, and a half-paid order if one does. Quantity is
 * capped for the same reason — two of one membership is one membership billed
 * twice.
 *
 * Refusing is not a limitation being papered over; it is the only version of
 * this that cannot half-succeed. The shopper is told to check out separately.
 */
export async function recurringMembershipInCart(
  siteId: number,
  lines: { productId: number; quantity: number }[],
  handle: DbHandle = db,
): Promise<{
  productId: number;
  name: string;
  tierId: number;
  interval: "month" | "year";
  stripeRecurringPriceId: string | null;
} | null> {
  const ids = [...new Set(lines.map((l) => l.productId))];
  if (ids.length === 0) return null;

  const recurring = await handle
    .select({
      id: products.id,
      name: products.name,
      tierId: products.grantsTierId,
      interval: products.grantsRenewalInterval,
      priceId: products.stripeRecurringPriceId,
    })
    .from(products)
    .where(
      and(
        inArray(products.id, ids),
        eq(products.siteId, siteId),
        ne(products.grantsRenewalInterval, "none"),
      ),
    );

  if (recurring.length === 0) return null;

  if (recurring.length > 1) {
    throw conflict(
      "Only one subscription can be bought at a time. Each renews on its own schedule, so " +
        "they have to be checked out separately.",
    );
  }

  const sub = recurring[0];
  const otherLines = lines.filter((l) => l.productId !== sub.id);
  if (otherLines.length > 0) {
    throw conflict(
      `"${sub.name}" renews automatically and has to be bought on its own. Check out the other ` +
        "items separately.",
    );
  }

  const line = lines.find((l) => l.productId === sub.id);
  if (line && line.quantity > 1) {
    throw conflict(`"${sub.name}" is a subscription — one per customer, not ${line.quantity}.`);
  }

  return {
    productId: sub.id,
    name: sub.name,
    tierId: sub.tierId as number,
    interval: sub.interval as "month" | "year",
    stripeRecurringPriceId: sub.priceId,
  };
}

/**
 * Extend a membership that a Stripe subscription just renewed (§18.9).
 *
 * Called from the Connect `invoice.paid` webhook, which is the **only** thing
 * that grants recurring access — never subscription creation, because a
 * subscription exists before its first invoice is paid.
 *
 * Idempotent on the invoice: Stripe redelivers for three days, and a second
 * delivery must not extend a member by another period for one payment. The
 * caller passes the invoice id and this refuses a repeat.
 */
export async function extendRenewedMembership(
  handle: DbHandle,
  input: {
    subscriptionId: string;
    /** Days of access this payment buys, from `intervalDays`. */
    days: number;
    /** Stripe's invoice id — the idempotency key. */
    invoiceId: string;
  },
  now: Date = new Date(),
): Promise<
  | {
      ok: true;
      membershipId: number;
      endsAt: Date | null;
      alreadyApplied: boolean;
      /** Who to meter the renewal against (§17). Resolved here so the caller never guesses. */
      orgId: string;
      siteId: number;
    }
  | { ok: false; reason: string }
> {
  /**
   * Joined out to the store rather than trusting anything on the event. The
   * subscription id is the only thing Stripe gives us, and the org it meters
   * against has to come from Markii's own rows — a merchant controls the
   * metadata on their own account.
   */
  const [membership] = await handle
    .select({
      id: customerMemberships.id,
      endsAt: customerMemberships.endsAt,
      revokedAt: customerMemberships.revokedAt,
      lastRenewalInvoiceId: customerMemberships.lastRenewalInvoiceId,
      siteId: customers.siteId,
      orgId: sites.orgId,
    })
    .from(customerMemberships)
    .innerJoin(customers, eq(customers.id, customerMemberships.customerId))
    .innerJoin(sites, eq(sites.id, customers.siteId))
    .where(eq(customerMemberships.stripeSubscriptionId, input.subscriptionId))
    .limit(1);

  if (!membership) {
    return { ok: false, reason: `No membership for subscription ${input.subscriptionId}.` };
  }

  /**
   * The last invoice that extended this membership, kept on the row so a
   * redelivery is recognisable. Without it, Stripe's three-day retry window
   * would hand a member up to three extra periods for one payment.
   */
  if (membership.lastRenewalInvoiceId === input.invoiceId) {
    return {
      ok: true,
      membershipId: membership.id,
      endsAt: membership.endsAt,
      alreadyApplied: true,
      orgId: membership.orgId,
      siteId: membership.siteId,
    };
  }

  const endsAt = extendedEndsAt(
    { endsAt: membership.endsAt, revokedAt: membership.revokedAt },
    input.days,
    now,
  );

  await handle
    .update(customerMemberships)
    .set({
      endsAt,
      /**
       * A successful renewal reinstates a revoked membership, matching the
       * one-off purchase path: taking the money and leaving access revoked is
       * the worse failure.
       */
      revokedAt: null,
      lastRenewalInvoiceId: input.invoiceId,
      updatedAt: now,
    })
    .where(eq(customerMemberships.id, membership.id));

  return {
    ok: true,
    membershipId: membership.id,
    endsAt,
    alreadyApplied: false,
    orgId: membership.orgId,
    siteId: membership.siteId,
  };
}

/**
 * Confer a membership from a subscription's **first** paid invoice (§18.9).
 *
 * Checkout deliberately writes no membership row — there is no honest state for
 * "exists but not yet paid" — so the first `invoice.paid` is what creates it.
 * Later invoices find the row by `stripe_subscription_id` and go through
 * `extendRenewedMembership` instead.
 *
 * **The ids come from Stripe metadata and are re-checked here, not trusted.** A
 * merchant can edit metadata on their own connected account, so this verifies
 * the product really belongs to the customer's store and really grants a tier.
 * Without that, a merchant could mint a membership on somebody else's store by
 * writing another store's customer id into their own subscription.
 */
export async function grantSubscriptionMembership(
  handle: DbHandle,
  input: {
    customerId: number;
    productId: number;
    subscriptionId: string;
    days: number;
    invoiceId: string;
  },
  now: Date = new Date(),
): Promise<
  | { ok: true; membershipId: number; tierId: number; endsAt: Date | null; orgId: string; siteId: number }
  | { ok: false; reason: string }
> {
  const [customer] = await handle
    .select({ id: customers.id, siteId: customers.siteId, orgId: sites.orgId })
    .from(customers)
    .innerJoin(sites, eq(sites.id, customers.siteId))
    .where(eq(customers.id, input.customerId))
    .limit(1);
  if (!customer) return { ok: false, reason: `No customer ${input.customerId}.` };

  /**
   * Scoped to the customer's own site. This is the check that makes the metadata
   * safe to read at all.
   */
  const [product] = await handle
    .select({ id: products.id, tierId: products.grantsTierId })
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.siteId, customer.siteId)))
    .limit(1);
  if (!product) {
    return {
      ok: false,
      reason: `Product ${input.productId} is not on customer ${input.customerId}'s store.`,
    };
  }
  if (product.tierId === null) {
    return { ok: false, reason: `Product ${input.productId} grants no membership tier.` };
  }
  const tierId = product.tierId;

  const [current] = await handle
    .select({ endsAt: customerMemberships.endsAt, revokedAt: customerMemberships.revokedAt })
    .from(customerMemberships)
    .where(
      and(
        eq(customerMemberships.customerId, input.customerId),
        eq(customerMemberships.tierId, tierId),
      ),
    )
    .limit(1);

  const endsAt = extendedEndsAt(current ?? null, input.days, now);

  const [row] = await handle
    .insert(customerMemberships)
    .values({
      customerId: input.customerId,
      tierId,
      startsAt: now,
      endsAt,
      source: "purchase",
      stripeSubscriptionId: input.subscriptionId,
      lastRenewalInvoiceId: input.invoiceId,
    })
    .onConflictDoUpdate({
      /**
       * A shopper who already holds this tier from a one-off purchase and then
       * subscribes keeps their remaining time — `extendedEndsAt` builds on it —
       * and the row gains the subscription that will now renew it.
       */
      target: [customerMemberships.customerId, customerMemberships.tierId],
      set: {
        endsAt,
        revokedAt: null,
        stripeSubscriptionId: input.subscriptionId,
        lastRenewalInvoiceId: input.invoiceId,
        updatedAt: now,
      },
    })
    .returning({ id: customerMemberships.id });

  return {
    ok: true,
    membershipId: row.id,
    tierId,
    endsAt,
    orgId: customer.orgId,
    siteId: customer.siteId,
  };
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

/**
 * Withdraw memberships a refunded order conferred (§18.9).
 *
 * The mirror of `revokeDeliveryForOrder`, and for the same reason: buy, use,
 * refund, keep the access is the whole digital-goods fraud pattern, and leaving
 * it open for memberships while closing it for downloads would just move the
 * hole.
 *
 * **Scoped two ways, so a partial refund does not over-revoke.** Only tiers
 * granted by the *refunded lines'* products are considered, and only memberships
 * whose `orderId` is this order — refunding a t-shirt from an order that also
 * contained a membership revokes nothing, and refunding an old order whose
 * membership has since been extended by a newer purchase leaves the newer one
 * alone, because `orderId` then points at that later order.
 *
 * **Known limit, stated rather than papered over:** refunding a purchase that
 * *extended* a membership revokes the whole thing, including time paid for by an
 * earlier order. Rolling back precisely would need the pre-extension expiry
 * stored, which no column holds. Revoking is the merchant-favourable direction
 * and `memberships.grant` puts it back in one call, so this errs the way the
 * digital-delivery precedent already does.
 */
export async function revokeMembershipsForOrder(
  handle: DbHandle,
  input: { orderId: number; siteId: number; productIds: number[] },
  now: Date = new Date(),
): Promise<{ membershipsRevoked: number; tierNames: string[] }> {
  const ids = [...new Set(input.productIds.filter((id): id is number => id != null))];
  if (ids.length === 0) return { membershipsRevoked: 0, tierNames: [] };

  const tiers = await handle
    .select({ tierId: products.grantsTierId, tierName: membershipTiers.name })
    .from(products)
    .innerJoin(membershipTiers, eq(membershipTiers.id, products.grantsTierId))
    .where(
      and(
        inArray(products.id, ids),
        eq(products.siteId, input.siteId),
        isNotNull(products.grantsTierId),
      ),
    );

  if (tiers.length === 0) return { membershipsRevoked: 0, tierNames: [] };

  const revoked = await handle
    .update(customerMemberships)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(customerMemberships.orderId, input.orderId),
        inArray(
          customerMemberships.tierId,
          tiers.map((t) => t.tierId as number),
        ),
        isNull(customerMemberships.revokedAt),
      ),
    )
    .returning({ tierId: customerMemberships.tierId });

  const names = revoked
    .map((r) => tiers.find((t) => t.tierId === r.tierId)?.tierName)
    .filter((n): n is string => Boolean(n));

  return { membershipsRevoked: revoked.length, tierNames: names };
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
