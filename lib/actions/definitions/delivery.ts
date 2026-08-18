import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../api";
import {
  digitalAssets,
  downloadGrants,
  licenceKeys,
  productDigitalAssets,
  products,
  variants,
} from "../../db";
import { expiryFor } from "../../commerce/delivery";
import { deleteFile, PRIVATE_BUCKET } from "../../storage";
import { siteScope } from "../../tenancy";
import { patchInverse } from "../inverse";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Digital delivery configuration (§18.8) — the D5 beachhead.
 *
 * The **upload itself** is not an action: bytes go to `POST /api/digital-assets`
 * as multipart, because a registry action takes JSON and base64-ing a 2 GB file
 * through an audit log is not a thing to do. That route registers the asset;
 * everything a merchant then does *with* it lives here.
 */

async function ownedProduct(ctx: ActionContext, productId: number) {
  if (!ctx.actor.orgId) throw notFound("Product");
  const [row] = await ctx.db
    .select({ id: products.id, siteId: products.siteId })
    .from(products)
    .where(and(eq(products.id, productId), siteScope(ctx.actor.orgId, products.siteId)))
    .limit(1);
  if (!row) throw notFound("Product");
  return row;
}

async function ownedAsset(ctx: ActionContext, assetId: number) {
  if (!ctx.actor.orgId) throw notFound("Digital asset");
  const [row] = await ctx.db
    .select()
    .from(digitalAssets)
    .where(and(eq(digitalAssets.id, assetId), eq(digitalAssets.orgId, ctx.actor.orgId)))
    .limit(1);
  if (!row) throw notFound("Digital asset");
  return row;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const attachDigitalAsset = defineAction({
  id: "delivery.attachAsset",
  description:
    "Attach an uploaded file to a product, so buying it delivers a download. Omit variantId to " +
    "deliver the file for every variant — the usual case for a single ebook or template.",
  input: z
    .object({
      productId: z.number().int().positive(),
      assetId: z.number().int().positive(),
      variantId: z.number().int().positive().nullish(),
      position: z.number().int().min(0).default(0),
    })
    .strict(),
  permission: "catalog.write",
  riskTier: "low",
  undoable: true,
  /**
   * Detaching is the inverse, and the attachment's id comes from the recorded
   * *result* rather than the diff — the diff is about the product, since that
   * is the entity a merchant recognises.
   */
  inverse: (recorded) => {
    const attachmentId = (recorded.result as { id?: number } | null)?.id;
    if (typeof attachmentId !== "number") return null;
    return {
      actionId: "delivery.detachAsset",
      input: { attachmentId },
      /**
       * Detaching records `digitalAssets` on the product, which is a list, not
       * the field this action wrote — there is no shared path to compare, so a
       * strict check would only ever pass vacuously. Detaching an attachment
       * that is already gone refuses on its own.
       */
      conflictCheck: "none" as const,
    };
  },
  async run(input, ctx) {
    await ownedProduct(ctx, input.productId);
    const asset = await ownedAsset(ctx, input.assetId);

    if (input.variantId != null) {
      const [variant] = await ctx.db
        .select({ id: variants.id })
        .from(variants)
        .where(and(eq(variants.id, input.variantId), eq(variants.productId, input.productId)))
        .limit(1);
      // A variant from another product would create an attachment that can
      // never match a sale — configured, and silently delivering nothing.
      if (!variant) throw badRequest("That variant does not belong to this product");
    }

    const [row] = await ctx.db
      .insert(productDigitalAssets)
      .values({
        productId: input.productId,
        variantId: input.variantId ?? null,
        assetId: input.assetId,
        position: input.position,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) throw conflict("That file is already attached to this product");

    ctx.recordDiff({
      entity: "product",
      entityId: String(input.productId),
      path: "digitalAssets",
      before: null,
      after: asset.fileName,
    });
    return row;
  },
});

export const detachDigitalAsset = defineAction({
  id: "delivery.detachAsset",
  description:
    "Stop delivering a file with a product. Downloads already granted to past buyers keep " +
    "working — detaching changes what future orders receive, it does not withdraw what was sold.",
  input: z.object({ attachmentId: z.number().int().positive() }).strict(),
  permission: "catalog.write",
  riskTier: "low",
  undoable: false,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Attachment");
    const [existing] = await ctx.db
      .select({ attachment: productDigitalAssets })
      .from(productDigitalAssets)
      .innerJoin(products, eq(products.id, productDigitalAssets.productId))
      .where(
        and(
          eq(productDigitalAssets.id, input.attachmentId),
          siteScope(ctx.actor.orgId, products.siteId),
        ),
      )
      .limit(1);
    if (!existing) throw notFound("Attachment");

    await ctx.db.delete(productDigitalAssets).where(eq(productDigitalAssets.id, input.attachmentId));
    ctx.recordDiff({
      entity: "product",
      entityId: String(existing.attachment.productId),
      path: "digitalAssets",
      before: existing.attachment.assetId,
      after: null,
    });
    return { detached: true, id: input.attachmentId };
  },
});

export const deleteDigitalAsset = defineAction({
  id: "delivery.deleteAsset",
  description:
    "Delete an uploaded file permanently, removing it from storage. **Past buyers lose access** " +
    "— their download links will report the file as gone. Detach it instead if you only want to " +
    "stop selling it.",
  input: z.object({ assetId: z.number().int().positive() }).strict(),
  permission: "catalog.write",
  /** Irreversible, and it reaches backwards into orders people already paid for. */
  riskTier: "high",
  undoable: false,
  async run(input, ctx) {
    const asset = await ownedAsset(ctx, input.assetId);

    const [{ n }] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(downloadGrants)
      .where(and(eq(downloadGrants.assetId, asset.id), isNull(downloadGrants.revokedAt)));

    await ctx.db.delete(digitalAssets).where(eq(digitalAssets.id, asset.id));

    /**
     * The object is removed only after the transaction commits. Storage cannot
     * be rolled back, so deleting inline would destroy the file even when the
     * action fails — and a dry run would delete it while reporting that it
     * changed nothing.
     */
    ctx.effect(`delete ${asset.storagePath} from storage`, async () => {
      await deleteFile(PRIVATE_BUCKET, asset.storagePath);
    });

    ctx.recordDiff({
      entity: "digitalAsset",
      entityId: String(asset.id),
      path: "deleted",
      before: asset.fileName,
      after: null,
    });

    return {
      deleted: true,
      id: asset.id,
      /** Stated back, because it is the consequence a merchant most needs to see. */
      activeGrantsBroken: Number(n),
    };
  },
});

// ---------------------------------------------------------------------------
// Download policy
// ---------------------------------------------------------------------------

export const setDownloadPolicy = defineAction({
  id: "delivery.setDownloadPolicy",
  description:
    "Set how many times a buyer may download this product's files and for how long. Null for " +
    "either means unlimited. Applies to future orders — it does not retroactively tighten " +
    "downloads already granted.",
  input: z
    .object({
      productId: z.number().int().positive(),
      downloadLimit: z.number().int().positive().nullable(),
      downloadExpiryDays: z.number().int().positive().nullable(),
    })
    .strict(),
  permission: "catalog.write",
  riskTier: "low",
  undoable: true,
  /**
   * Both fields are required on every call but only changed ones are recorded,
   * so the unchanged one is taken from the original input — where "unchanged"
   * means the value it still holds.
   */
  inverse: patchInverse({
    actionId: "delivery.setDownloadPolicy",
    idField: "productId",
    carryFromInput: ["downloadLimit", "downloadExpiryDays"],
  }),
  async run(input, ctx) {
    const product = await ownedProduct(ctx, input.productId);

    const [before] = await ctx.db
      .select({
        downloadLimit: products.downloadLimit,
        downloadExpiryDays: products.downloadExpiryDays,
      })
      .from(products)
      .where(eq(products.id, product.id))
      .limit(1);

    const [row] = await ctx.db
      .update(products)
      .set({
        downloadLimit: input.downloadLimit,
        downloadExpiryDays: input.downloadExpiryDays,
        updatedAt: new Date(),
      })
      .where(eq(products.id, product.id))
      .returning();

    for (const key of ["downloadLimit", "downloadExpiryDays"] as const) {
      if (before?.[key] !== row[key]) {
        ctx.recordDiff({
          entity: "product",
          entityId: String(product.id),
          path: key,
          before: before?.[key] ?? null,
          after: row[key],
        });
      }
    }
    return { productId: product.id, downloadLimit: row.downloadLimit, downloadExpiryDays: row.downloadExpiryDays };
  },
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

async function ownedGrant(ctx: ActionContext, grantId: number) {
  if (!ctx.actor.orgId) throw notFound("Download");
  const [row] = await ctx.db
    .select({ grant: downloadGrants })
    .from(downloadGrants)
    .innerJoin(digitalAssets, eq(digitalAssets.id, downloadGrants.assetId))
    .where(and(eq(downloadGrants.id, grantId), eq(digitalAssets.orgId, ctx.actor.orgId)))
    .limit(1);
  if (!row) throw notFound("Download");
  return row.grant;
}

export const reissueDownload = defineAction({
  id: "delivery.reissueDownload",
  description:
    "Give a buyer their download back — reset the counter, extend the expiry, or un-revoke it. " +
    "The everyday support fix for someone who lost the file or hit their limit legitimately.",
  input: z
    .object({
      grantId: z.number().int().positive(),
      /** Reset the used count to zero. */
      resetCount: z.boolean().default(true),
      /** Push expiry this many days from now. Omit to leave it alone. */
      extendDays: z.number().int().positive().max(3650).optional(),
      /** Lift a revocation — for a refund that was reversed, say. */
      unrevoke: z.boolean().default(false),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    const grant = await ownedGrant(ctx, input.grantId);

    const patch: Record<string, unknown> = {};
    if (input.resetCount) patch.downloadCount = 0;
    if (input.extendDays != null) patch.expiresAt = expiryFor(input.extendDays);
    if (input.unrevoke) {
      patch.revokedAt = null;
      patch.revokedReason = null;
    }
    if (Object.keys(patch).length === 0) throw badRequest("No changes supplied");

    const [row] = await ctx.db
      .update(downloadGrants)
      .set(patch)
      .where(eq(downloadGrants.id, grant.id))
      .returning();

    for (const key of Object.keys(patch)) {
      ctx.recordDiff({
        entity: "downloadGrant",
        entityId: String(grant.id),
        path: key,
        before: (grant as unknown as Record<string, unknown>)[key] ?? null,
        after: (row as unknown as Record<string, unknown>)[key] ?? null,
      });
    }

    return {
      grantId: row.id,
      downloadCount: row.downloadCount,
      downloadLimit: row.downloadLimit,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revoked: row.revokedAt != null,
    };
  },
});

export const revokeDownload = defineAction({
  id: "delivery.revokeDownload",
  description:
    "Withdraw a buyer's access to a file. Used for fraud and chargebacks; a refund revokes its " +
    "own downloads automatically. The record of what was bought and downloaded is kept.",
  input: z
    .object({
      grantId: z.number().int().positive(),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: true,
  /**
   * Lifting the revocation is the exact inverse — and only that. `resetCount`
   * is false because revoking never touched the counter, and an undo that
   * quietly handed back a fresh set of downloads would give the buyer more than
   * they had before it.
   */
  inverse: (recorded) => {
    const grantId = (recorded.input as { grantId?: number } | null)?.grantId;
    if (typeof grantId !== "number") return null;
    return {
      actionId: "delivery.reissueDownload",
      input: { grantId, resetCount: false, unrevoke: true },
    };
  },
  async run(input, ctx) {
    const grant = await ownedGrant(ctx, input.grantId);
    if (grant.revokedAt != null) throw conflict("That download is already revoked");

    const revokedAt = new Date();
    await ctx.db
      .update(downloadGrants)
      .set({ revokedAt, revokedReason: input.reason })
      .where(eq(downloadGrants.id, grant.id));

    /**
     * The recorded `after` is the timestamp, not the reason. It read
     * `after: input.reason` on a path called `revokedAt` until undo was built,
     * which made the field's own history unreadable — and made every undo of it
     * look like a conflict, since what is actually in the column is a time.
     */
    ctx.recordDiff({
      entity: "downloadGrant",
      entityId: String(grant.id),
      path: "revokedAt",
      before: null,
      after: revokedAt.toISOString(),
    });
    ctx.recordDiff({
      entity: "downloadGrant",
      entityId: String(grant.id),
      path: "revokedReason",
      before: null,
      after: input.reason,
    });
    return { grantId: grant.id, revoked: true };
  },
});

// ---------------------------------------------------------------------------
// Licence keys
// ---------------------------------------------------------------------------

export const addLicenceKeys = defineAction({
  id: "delivery.addLicenceKeys",
  description:
    "Add licence keys to a product's pool. **Markii never generates keys** — a key it invented " +
    "would not validate against your software. Supply keys your own system issued; each sale " +
    "claims one, and an empty pool means the next order is owed a key it cannot be given.",
  input: z
    .object({
      productId: z.number().int().positive(),
      variantId: z.number().int().positive().nullish(),
      keys: z.array(z.string().min(1).max(500)).min(1).max(10_000),
    })
    .strict(),
  permission: "catalog.write",
  riskTier: "medium",
  undoable: false,
  /** The keys are the product. An audit row holding them is a list of stock to steal. */
  redactInput: (input) => ({
    productId: input.productId,
    variantId: input.variantId ?? null,
    keys: `[${input.keys.length} key(s) redacted]`,
  }),
  async run(input, ctx) {
    const product = await ownedProduct(ctx, input.productId);
    if (!ctx.actor.orgId) throw notFound("Product");

    // Duplicates within one submission would silently become one key, leaving
    // the merchant believing they loaded more stock than they did.
    const unique = [...new Set(input.keys.map((k) => k.trim()).filter(Boolean))];
    if (unique.length === 0) throw badRequest("No usable keys supplied");

    const inserted = await ctx.db
      .insert(licenceKeys)
      .values(
        unique.map((key) => ({
          orgId: ctx.actor.orgId as string,
          productId: product.id,
          variantId: input.variantId ?? null,
          key,
        })),
      )
      // A re-submitted CSV must not double the pool.
      .onConflictDoNothing({ target: [licenceKeys.orgId, licenceKeys.key] })
      .returning({ id: licenceKeys.id });

    ctx.recordDiff({
      entity: "product",
      entityId: String(product.id),
      path: "licenceKeys",
      before: null,
      after: `+${inserted.length}`,
    });

    return {
      productId: product.id,
      added: inserted.length,
      /** Submitted but already present — reported, not silently absorbed. */
      duplicatesIgnored: unique.length - inserted.length,
      /** Keys still unclaimed, so an exhausted pool is visible before it bites. */
      available: await availableKeyCount(ctx, product.id),
    };
  },
});

async function availableKeyCount(ctx: ActionContext, productId: number): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(licenceKeys)
    .where(
      and(
        eq(licenceKeys.productId, productId),
        isNull(licenceKeys.assignedAt),
        isNull(licenceKeys.revokedAt),
      ),
    );
  return Number(row?.n ?? 0);
}
