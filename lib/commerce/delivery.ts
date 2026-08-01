import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  digitalAssets,
  downloadGrants,
  licenceKeys,
  orderLines,
  productDigitalAssets,
  products,
  type DbHandle,
  type DownloadGrant,
} from "../db";

/**
 * Digital delivery (§18.8) — the D5 beachhead.
 *
 * Two rules shape everything here.
 *
 * **The grant is the entitlement; the URL is not.** A signed URL is minted per
 * redemption and lives five minutes. Anything durable — the download cap, the
 * expiry, the revocation after a refund — lives on the grant, because a URL that
 * has been handed out cannot be counted or withdrawn.
 *
 * **Bytes never pass through a route handler** (G5). The download route
 * redirects to Supabase; proxying would pay egress twice and time out a function
 * on a large file. The cost of that choice is that we meter bytes *authorised*
 * rather than delivered, which is stated where it is recorded rather than
 * quietly rounded away.
 */

/** The shopper's only credential for a grant. 256 bits, like the cart token. */
export function newGrantToken(): string {
  return randomBytes(32).toString("base64url");
}

export type GrantableItem = {
  orderLineId: number | null;
  productId: number;
  variantId: number | null;
};

/**
 * Why a grant cannot be redeemed right now. Each case is distinct because a
 * shopper who hit their download limit, one whose link expired, and one whose
 * order was refunded need three different messages — and only the last is not a
 * problem the merchant might want to fix for them.
 */
export type RedemptionRefusal =
  | { code: "revoked"; message: string }
  | { code: "expired"; message: string }
  | { code: "limit_reached"; message: string };

/** Whether a grant may be redeemed, and if not, precisely why. */
export function checkRedeemable(
  grant: Pick<
    DownloadGrant,
    "revokedAt" | "revokedReason" | "expiresAt" | "downloadLimit" | "downloadCount"
  >,
  now = new Date(),
): RedemptionRefusal | null {
  if (grant.revokedAt != null) {
    return {
      code: "revoked",
      message:
        grant.revokedReason ??
        "Access to this download was withdrawn. Contact the store if you think this is wrong.",
    };
  }
  if (grant.expiresAt != null && grant.expiresAt.getTime() <= now.getTime()) {
    return {
      code: "expired",
      message: `This download link expired on ${grant.expiresAt.toISOString().slice(0, 10)}.`,
    };
  }
  if (grant.downloadLimit != null && grant.downloadCount >= grant.downloadLimit) {
    return {
      code: "limit_reached",
      message: `This download has been used ${grant.downloadCount} of ${grant.downloadLimit} times.`,
    };
  }
  return null;
}

/** When a grant should expire, given the product's policy. Null means never. */
export function expiryFor(downloadExpiryDays: number | null, from = new Date()): Date | null {
  if (downloadExpiryDays == null) return null;
  return new Date(from.getTime() + downloadExpiryDays * 24 * 60 * 60 * 1000);
}

export type IssuedDelivery = {
  grants: { id: number; token: string; assetId: number; fileName: string }[];
  licenceKeys: { id: number; key: string; productId: number }[];
  /** Products that should have delivered a key but had none left in the pool. */
  exhaustedProductIds: number[];
};

/**
 * Issues downloads and licence keys for a completed order.
 *
 * Runs inside the completion transaction, so a paid order can never exist
 * without the access it was sold. The alternative — issuing afterwards — means a
 * crash between the two leaves a buyer charged for a file they cannot reach,
 * and nothing in the system knows it is missing.
 *
 * **One grant per asset per order, not per unit.** Buying three copies of an
 * ebook does not mean three separate download links; it means one entitlement.
 * Licence keys are the opposite — those *are* per unit, since a key is the thing
 * being sold.
 *
 * **An exhausted key pool does not fail the order.** The shopper has already
 * paid — on the x402 rail, irreversibly on-chain — so refusing here would take
 * their money and give nothing. The shortfall is returned so the caller can put
 * it on the order timeline for the merchant to resolve.
 */
export async function issueDelivery(
  tx: DbHandle,
  input: {
    orderId: number;
    orgId: string;
    customerId: number | null;
    email: string | null;
    items: (GrantableItem & { quantity: number })[];
  },
): Promise<IssuedDelivery> {
  const result: IssuedDelivery = { grants: [], licenceKeys: [], exhaustedProductIds: [] };
  if (input.items.length === 0) return result;

  const now = new Date();

  for (const item of input.items) {
    const [product] = await tx
      .select({
        downloadLimit: products.downloadLimit,
        downloadExpiryDays: products.downloadExpiryDays,
      })
      .from(products)
      .where(eq(products.id, item.productId))
      .limit(1);
    if (!product) continue;

    /**
     * Assets attached to the product as a whole (`variantId` null) plus any
     * attached to the exact variant bought. The null case is the common one — a
     * single ebook — and requiring a row per variant would make the simple
     * setup the fiddly one.
     */
    const attachments = await tx
      .select({ asset: digitalAssets })
      .from(productDigitalAssets)
      .innerJoin(digitalAssets, eq(digitalAssets.id, productDigitalAssets.assetId))
      .where(
        and(
          eq(productDigitalAssets.productId, item.productId),
          item.variantId == null
            ? isNull(productDigitalAssets.variantId)
            : sql`(${productDigitalAssets.variantId} is null or ${productDigitalAssets.variantId} = ${item.variantId})`,
        ),
      );

    for (const { asset } of attachments) {
      const token = newGrantToken();
      const [grant] = await tx
        .insert(downloadGrants)
        .values({
          token,
          orderId: input.orderId,
          orderLineId: item.orderLineId,
          assetId: asset.id,
          customerId: input.customerId,
          email: input.email,
          downloadLimit: product.downloadLimit,
          expiresAt: expiryFor(product.downloadExpiryDays, now),
        })
        .returning({ id: downloadGrants.id });

      result.grants.push({
        id: grant.id,
        token,
        assetId: asset.id,
        fileName: asset.fileName,
      });
    }

    /**
     * Keys are claimed one per unit, and the claim is a conditional UPDATE
     * rather than a select-then-write: two concurrent orders for the last key
     * would otherwise both read it as free and both be handed it. `for update
     * skip locked` lets the second order move straight to the next key instead
     * of blocking behind the first.
     */
    for (let unit = 0; unit < item.quantity; unit++) {
      const claimed = await tx
        .update(licenceKeys)
        .set({
          orderId: input.orderId,
          orderLineId: item.orderLineId,
          customerId: input.customerId,
          assignedAt: now,
        })
        .where(
          sql`${licenceKeys.id} = (
            select id from ${licenceKeys}
            where product_id = ${item.productId}
              and assigned_at is null
              and revoked_at is null
              and (variant_id is null or variant_id = ${item.variantId})
            order by id
            for update skip locked
            limit 1
          )`,
        )
        .returning({ id: licenceKeys.id, key: licenceKeys.key });

      if (claimed.length === 0) {
        // Only report a shortfall for products that actually sell keys.
        const [anyKey] = await tx
          .select({ id: licenceKeys.id })
          .from(licenceKeys)
          .where(eq(licenceKeys.productId, item.productId))
          .limit(1);
        if (anyKey && !result.exhaustedProductIds.includes(item.productId)) {
          result.exhaustedProductIds.push(item.productId);
        }
        break;
      }
      result.licenceKeys.push({
        id: claimed[0].id,
        key: claimed[0].key,
        productId: item.productId,
      });
    }
  }

  return result;
}

/**
 * What an order bought, in the shape {@link issueDelivery} needs.
 *
 * Read from `order_lines` rather than the cart, because the lines are the
 * frozen record of what was actually sold (§18.7) and the cart may already have
 * been converted.
 */
export async function deliverableItems(
  tx: DbHandle,
  orderId: number,
): Promise<(GrantableItem & { quantity: number })[]> {
  const lines = await tx
    .select({
      id: orderLines.id,
      productId: orderLines.productId,
      variantId: orderLines.variantId,
      quantity: orderLines.quantity,
    })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId));

  return lines
    .filter((l): l is typeof l & { productId: number } => l.productId != null)
    .map((l) => ({
      orderLineId: l.id,
      productId: l.productId,
      variantId: l.variantId,
      quantity: l.quantity,
    }));
}

export type DeliveryPayload = {
  downloads: {
    fileName: string;
    sizeBytes: number;
    url: string;
    downloadLimit: number | null;
    downloadsUsed: number;
    expiresAt: string | null;
  }[];
  licenceKeys: { key: string; productId: number }[];
};

/**
 * What a buyer receives, in the shape a checkout response returns.
 *
 * Built fresh on each call rather than stored, so a re-fetch after a retried
 * completion shows the current counts. The URLs here point at the **grant**
 * (`/download/:token`), never at storage: a storage URL expires in minutes and
 * would be dead by the time an emailed receipt is opened, while a grant link
 * works for as long as the merchant's policy allows.
 *
 * This is what makes the D5 agent-purchase story actually finish — an agent
 * discovers, buys, and receives the goods in one exchange, with no address and
 * no shipping step.
 */
export async function deliveryForOrder(
  tx: DbHandle,
  orderId: number,
  storeBaseUrl: string,
): Promise<DeliveryPayload> {
  const grants = await tx
    .select({ grant: downloadGrants, asset: digitalAssets })
    .from(downloadGrants)
    .innerJoin(digitalAssets, eq(digitalAssets.id, downloadGrants.assetId))
    .where(and(eq(downloadGrants.orderId, orderId), isNull(downloadGrants.revokedAt)));

  const keys = await tx
    .select({ key: licenceKeys.key, productId: licenceKeys.productId })
    .from(licenceKeys)
    .where(and(eq(licenceKeys.orderId, orderId), isNull(licenceKeys.revokedAt)));

  return {
    downloads: grants.map(({ grant, asset }) => ({
      fileName: asset.fileName,
      sizeBytes: asset.sizeBytes,
      url: `${storeBaseUrl.replace(/\/$/, "")}/download/${grant.token}`,
      downloadLimit: grant.downloadLimit,
      downloadsUsed: grant.downloadCount,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
    })),
    licenceKeys: keys.map((k) => ({ key: k.key, productId: k.productId })),
  };
}

/**
 * Withdraws downloads and returns licence keys to the pool after a refund.
 *
 * Keys go back rather than being destroyed: an unused key is inventory the
 * merchant paid for, and burning it on a refunded order quietly shrinks their
 * stock. Grants are revoked **softly** so the record of what was bought and
 * downloaded survives a dispute.
 */
export async function revokeDeliveryForOrder(
  tx: DbHandle,
  orderId: number,
  reason: string,
  opts: { orderLineIds?: number[] } = {},
): Promise<{ grantsRevoked: number; keysReturned: number }> {
  const scoped = opts.orderLineIds;

  const grantWhere =
    scoped && scoped.length > 0
      ? and(
          eq(downloadGrants.orderId, orderId),
          isNull(downloadGrants.revokedAt),
          sql`${downloadGrants.orderLineId} = any(${sql.raw(`array[${scoped.join(",")}]`)})`,
        )
      : and(eq(downloadGrants.orderId, orderId), isNull(downloadGrants.revokedAt));

  const revoked = await tx
    .update(downloadGrants)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(grantWhere)
    .returning({ id: downloadGrants.id });

  const keyWhere =
    scoped && scoped.length > 0
      ? and(
          eq(licenceKeys.orderId, orderId),
          sql`${licenceKeys.orderLineId} = any(${sql.raw(`array[${scoped.join(",")}]`)})`,
        )
      : eq(licenceKeys.orderId, orderId);

  const returned = await tx
    .update(licenceKeys)
    .set({ orderId: null, orderLineId: null, customerId: null, assignedAt: null })
    .where(keyWhere)
    .returning({ id: licenceKeys.id });

  return { grantsRevoked: revoked.length, keysReturned: returned.length };
}
