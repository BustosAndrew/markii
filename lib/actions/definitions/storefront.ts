import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { notFound } from "../../api";
import { mintStorefrontKey } from "../../auth/storefront-key-format";
import { sites, storefrontKeys } from "../../db";
import { ownSites } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Storefront secret keys (D53, 2026-11-20) — what an exported storefront's
 * server presents so a signed-in shopper can buy and use members-only products
 * there. The reasoning is on the table (`storefrontKeys`) and the lookup
 * (`lib/auth/storefront-keys.ts`).
 *
 * Per store, never org-wide: a key opens one store's shopper routes, so a
 * member scoped to that store may manage it, and `ownSites` (store-scoped,
 * D52) is what finds the site.
 */

async function ownedSite(ctx: ActionContext, siteId: number) {
  if (!ctx.actor.orgId) throw notFound("Site");
  const [row] = await ctx.db
    .select({ id: sites.id, slug: sites.slug })
    .from(sites)
    .where(and(eq(sites.id, siteId), ownSites(ctx.actor.orgId)))
    .limit(1);
  if (!row) throw notFound("Site");
  return row;
}

export const createStorefrontKey = defineAction({
  id: "storefront.createKey",
  description:
    "Create a secret key an exported storefront's server uses to act for its signed-in shoppers " +
    "on this store's cart, checkout and membership routes. The key is shown once.",
  input: z
    .object({
      siteId: z.number().int().positive(),
      label: z.string().trim().min(1).max(80),
    })
    .strict(),
  /** The developer's credential, like API tokens — the role that builds exports holds it. */
  permission: "tokens.manage",
  /**
   * High, and step-up: whoever holds the key can act as **any** customer of
   * this store — see their memberships, unlock members-only products, cancel
   * their renewals. That is granting access, which is what step-up is for, and
   * no agent or token may mint one.
   */
  riskTier: "high",
  requiresStepUp: true,
  /** Revoking is the way back, and it is its own action. The plaintext cannot be un-shown. */
  undoable: false,
  redactResult: (result) => ({ ...(result as Record<string, unknown>), key: "[shown once — not stored]" }),
  async run(input, ctx) {
    const site = await ownedSite(ctx, input.siteId);
    if (ctx.dryRun) return { siteId: site.id, label: input.label, id: 0, prefix: "", key: "" };

    const minted = mintStorefrontKey();
    const [row] = await ctx.db
      .insert(storefrontKeys)
      .values({
        siteId: site.id,
        label: input.label,
        keyHash: minted.hash,
        prefix: minted.prefix,
        createdByUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
      })
      .returning({ id: storefrontKeys.id });

    ctx.recordDiff({ entity: "storefront_key", entityId: String(row.id), path: "created", before: null, after: minted.prefix });
    return { siteId: site.id, label: input.label, id: row.id, prefix: minted.prefix, key: minted.plaintext };
  },
});

export const revokeStorefrontKey = defineAction({
  id: "storefront.revokeKey",
  description: "Revoke a storefront secret key. Requests carrying it are refused from then on.",
  input: z
    .object({
      siteId: z.number().int().positive(),
      keyId: z.number().int().positive(),
    })
    .strict(),
  permission: "tokens.manage",
  /** Revoking only ever removes access, so it is not held behind step-up — a leaked key must be quick to kill. */
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    const site = await ownedSite(ctx, input.siteId);
    const [row] = await ctx.db
      .select({ id: storefrontKeys.id, prefix: storefrontKeys.prefix, revokedAt: storefrontKeys.revokedAt })
      .from(storefrontKeys)
      .where(and(eq(storefrontKeys.id, input.keyId), eq(storefrontKeys.siteId, site.id)))
      .limit(1);
    if (!row) throw notFound("Storefront key");
    if (row.revokedAt) return { keyId: row.id, prefix: row.prefix, revokedAt: row.revokedAt.toISOString(), alreadyRevoked: true };

    const now = new Date();
    await ctx.db
      .update(storefrontKeys)
      .set({ revokedAt: now })
      .where(and(eq(storefrontKeys.id, row.id), isNull(storefrontKeys.revokedAt)));
    ctx.recordDiff({ entity: "storefront_key", entityId: String(row.id), path: "revokedAt", before: null, after: now.toISOString() });
    return { keyId: row.id, prefix: row.prefix, revokedAt: now.toISOString(), alreadyRevoked: false };
  },
});
