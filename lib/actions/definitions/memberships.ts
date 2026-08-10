import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { conflict, notFound, slugify } from "../../api";
import {
  customerMemberships,
  customers,
  membershipTiers,
  products,
  sites,
} from "../../db";
import { extendedEndsAt, membershipStatus } from "../../commerce/memberships";
import { ownSites, siteScope } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Membership actions (§18.9).
 *
 * Granting access is a **merchant** decision, so every one of these is
 * `commerce.write` and none of them is reachable by a shopper — a shopper gets a
 * membership by buying a product that grants one, which happens inside order
 * completion, not through this registry.
 */

async function ownedTier(ctx: ActionContext, id: number) {
  if (!ctx.actor.orgId) throw notFound("Membership tier");
  const [row] = await ctx.db
    .select()
    .from(membershipTiers)
    .where(and(eq(membershipTiers.id, id), siteScope(ctx.actor.orgId, membershipTiers.siteId)))
    .limit(1);
  if (!row) throw notFound("Membership tier");
  return row;
}

async function ownedCustomer(ctx: ActionContext, id: number) {
  if (!ctx.actor.orgId) throw notFound("Customer");
  const [row] = await ctx.db
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), siteScope(ctx.actor.orgId, customers.siteId)))
    .limit(1);
  if (!row) throw notFound("Customer");
  return row;
}

export const createTier = defineAction({
  id: "memberships.createTier",
  description:
    "Create a membership tier for a store. Products can then require this tier (only members may " +
    "view or buy them) or grant it (buying confers membership).",
  input: z
    .object({
      siteId: z.number().int().positive(),
      name: z.string().min(1).max(120),
      handle: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).nullish(),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "low",
  undoable: false,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Site");
    const [site] = await ctx.db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, input.siteId), ownSites(ctx.actor.orgId)))
      .limit(1);
    if (!site) throw notFound("Site");

    const handle = slugify(input.handle ?? input.name);

    const [existing] = await ctx.db
      .select({ id: membershipTiers.id })
      .from(membershipTiers)
      .where(and(eq(membershipTiers.siteId, site.id), eq(membershipTiers.handle, handle)))
      .limit(1);
    if (existing) throw conflict(`A tier with the handle "${handle}" already exists.`);

    const [row] = await ctx.db
      .insert(membershipTiers)
      .values({
        siteId: site.id,
        name: input.name,
        handle,
        description: input.description ?? null,
      })
      .returning();

    ctx.recordDiff({
      entity: "membership_tier",
      entityId: String(row.id),
      path: "name",
      before: null,
      after: row.name,
    });

    return row;
  },
});

export const updateTier = defineAction({
  id: "memberships.updateTier",
  description: "Rename a membership tier or change its description.",
  input: z
    .object({
      tierId: z.number().int().positive(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).nullish(),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "low",
  undoable: true,
  async run({ tierId, ...patch }, ctx) {
    const tier = await ownedTier(ctx, tierId);

    /**
     * The handle is deliberately not editable. It is the stable identifier a
     * merchant may have put in storefront copy or a link, and renaming it would
     * break those silently while looking like a cosmetic edit.
     */
    const [row] = await ctx.db
      .update(membershipTiers)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(membershipTiers.id, tier.id))
      .returning();

    if (patch.name !== undefined && patch.name !== tier.name) {
      ctx.recordDiff({
        entity: "membership_tier",
        entityId: String(tier.id),
        path: "name",
        before: tier.name,
        after: patch.name,
      });
    }

    return row;
  },
});

export const deleteTier = defineAction({
  id: "memberships.deleteTier",
  description:
    "Delete a membership tier. Every membership in it is deleted with it, and any product that " +
    "required it becomes visible to everyone.",
  input: z.object({ tierId: z.number().int().positive() }).strict(),
  permission: "commerce.write",
  /**
   * High, and not because of the row count. `products.requires_tier_id` is
   * `on delete set null`, so deleting a tier **ungates every product behind
   * it** — paid-for content silently becomes public, and nothing errors.
   */
  riskTier: "high",
  undoable: false,
  async run(input, ctx) {
    const tier = await ownedTier(ctx, input.tierId);

    const gated = await ctx.db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.requiresTierId, tier.id));

    const members = await ctx.db
      .select({ id: customerMemberships.id })
      .from(customerMemberships)
      .where(eq(customerMemberships.tierId, tier.id));

    await ctx.db.delete(membershipTiers).where(eq(membershipTiers.id, tier.id));

    ctx.recordDiff({
      entity: "membership_tier",
      entityId: String(tier.id),
      path: "name",
      before: tier.name,
      after: null,
    });

    return {
      deleted: true,
      id: tier.id,
      /** Stated so the caller can warn rather than discover it afterwards. */
      productsUngated: gated.length,
      membershipsRemoved: members.length,
    };
  },
});

export const grantMembership = defineAction({
  id: "memberships.grant",
  description:
    "Give a customer a membership, or extend one they already hold. Duration is in days; omit it " +
    "for a membership that never expires. Extending starts from their current expiry, so renewing " +
    "early does not forfeit unused time.",
  input: z
    .object({
      customerId: z.number().int().positive(),
      tierId: z.number().int().positive(),
      durationDays: z.number().int().positive().max(3650).nullish(),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: true,
  async run(input, ctx) {
    const customer = await ownedCustomer(ctx, input.customerId);
    const tier = await ownedTier(ctx, input.tierId);

    /**
     * Both belong to the caller's org, but not necessarily to the *same store*.
     * A tier gates one store's catalog and a customer belongs to one store, so
     * granting across them would produce a membership that can never be used.
     */
    if (tier.siteId !== customer.siteId) {
      throw conflict("That tier belongs to a different store than the customer.");
    }

    const [current] = await ctx.db
      .select()
      .from(customerMemberships)
      .where(
        and(
          eq(customerMemberships.customerId, customer.id),
          eq(customerMemberships.tierId, tier.id),
        ),
      )
      .limit(1);

    const now = new Date();
    const endsAt = extendedEndsAt(current ?? null, input.durationDays ?? null, now);

    const [row] = await ctx.db
      .insert(customerMemberships)
      .values({
        customerId: customer.id,
        tierId: tier.id,
        startsAt: now,
        endsAt,
        source: "manual",
        orderId: null,
      })
      .onConflictDoUpdate({
        target: [customerMemberships.customerId, customerMemberships.tierId],
        set: {
          endsAt,
          // Granting again is how a merchant reverses a revocation.
          revokedAt: null,
          updatedAt: now,
        },
      })
      .returning();

    ctx.recordDiff({
      entity: "customer_membership",
      entityId: String(row.id),
      path: "endsAt",
      before: current?.endsAt?.toISOString() ?? null,
      after: endsAt?.toISOString() ?? null,
    });

    const renews =
      Boolean(row.stripeSubscriptionId) && row.renewalCanceledAt === null;
    return {
      id: row.id,
      tier: { id: tier.id, name: tier.name, handle: tier.handle },
      status: membershipStatus(row, now),
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      source: row.source,
      orderId: row.orderId,
      createdAt: row.createdAt.toISOString(),
      renews,
      renewalCanceledAt: row.renewalCanceledAt?.toISOString() ?? null,
      accessEndsAt: row.endsAt?.toISOString() ?? null,
      cancellable: renews,
    };
  },
});

export const revokeMembership = defineAction({
  id: "memberships.revoke",
  description:
    "End a customer's membership now. Their access stops immediately; the record is kept so the " +
    "history still shows they held it.",
  input: z
    .object({
      customerId: z.number().int().positive(),
      tierId: z.number().int().positive(),
    })
    .strict(),
  permission: "commerce.write",
  /**
   * Medium rather than high: it takes access away from one person and a grant
   * puts it straight back, unlike `deleteTier`, which ungates a whole catalog.
   */
  riskTier: "medium",
  undoable: true,
  async run(input, ctx) {
    const customer = await ownedCustomer(ctx, input.customerId);
    const tier = await ownedTier(ctx, input.tierId);

    const [current] = await ctx.db
      .select()
      .from(customerMemberships)
      .where(
        and(
          eq(customerMemberships.customerId, customer.id),
          eq(customerMemberships.tierId, tier.id),
        ),
      )
      .limit(1);
    if (!current) throw notFound("Membership");

    const now = new Date();
    const serialize = (
      row: typeof current,
      alreadyRevoked: boolean,
    ) => {
      const renews =
        Boolean(row.stripeSubscriptionId) && row.renewalCanceledAt === null;
      return {
        id: row.id,
        tier: { id: tier.id, name: tier.name, handle: tier.handle },
        status: membershipStatus(row, now),
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        source: row.source,
        orderId: row.orderId,
        createdAt: row.createdAt.toISOString(),
        renews,
        renewalCanceledAt: row.renewalCanceledAt?.toISOString() ?? null,
        accessEndsAt: row.endsAt?.toISOString() ?? null,
        cancellable: renews,
        alreadyRevoked,
      };
    };

    if (membershipStatus(current, now) === "revoked") {
      // Already revoked: re-stamping would move the date and misreport when
      // access actually ended.
      return serialize(current, true);
    }

    const [row] = await ctx.db
      .update(customerMemberships)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(customerMemberships.id, current.id))
      .returning();

    ctx.recordDiff({
      entity: "customer_membership",
      entityId: String(current.id),
      path: "revokedAt",
      before: null,
      after: now.toISOString(),
    });

    return serialize(row, false);
  },
});
