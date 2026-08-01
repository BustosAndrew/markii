import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { checkRedeemable } from "@/lib/commerce/delivery";
import { db, digitalAssets, downloadEvents, downloadGrants, sites } from "@/lib/db";
import { isStorageConfigured, signedDownloadUrl } from "@/lib/storage";

/**
 * `GET /_sites/:site/download/:token` (§18.8) — redeem a download grant.
 *
 * **This route never serves bytes.** It authorises, meters, and then 302s to a
 * five-minute signed Supabase URL. G5 makes that structural rather than a
 * preference: proxying a 2 GB course video would pay egress twice (Supabase's
 * *and* Vercel's) and blow the function timeout, and the bandwidth line is the
 * one D2 identified as most likely to break the model for a digital-goods
 * beachhead.
 *
 * The token is the shopper's only credential — guests have no account, and the
 * emailed link *is* their access. So it is a random 256-bit value, and an
 * unknown one gets a flat 404 rather than a message distinguishing "no such
 * grant" from "not yours", which would make the space enumerable.
 */
export const GET = handler(async (req, { params }) => {
  const { site: slug, token } = (await params) as { site: string; token: string };

  const [store] = await db.select().from(sites).where(eq(sites.slug, slug)).limit(1);
  if (!store) throw notFound("Store");

  if (!isStorageConfigured()) {
    return NextResponse.json(
      {
        error: {
          code: "CONFIGURATION_REQUIRED",
          message: "Downloads are not available on this store yet.",
          details: {
            resolution:
              "File storage is not configured for this deployment. The purchase is recorded and " +
              "the download will work once it is — no need to buy again.",
          },
        },
      },
      { status: 503 },
    );
  }

  /**
   * Counter increment and limit check happen in one transaction under a row
   * lock. Two clicks on the same link half a second apart would otherwise both
   * read `downloadCount = 4` against a limit of 5 and both be allowed — the
   * read-then-write race, on the one number the merchant is relying on to stop
   * a file being shared.
   */
  const outcome = await db.transaction(async (tx) => {
    const [grant] = await tx
      .select()
      .from(downloadGrants)
      .where(eq(downloadGrants.token, token))
      .limit(1)
      .for("update");
    if (!grant) return { kind: "not_found" as const };

    const [asset] = await tx
      .select()
      .from(digitalAssets)
      .where(eq(digitalAssets.id, grant.assetId))
      .limit(1);
    // The asset was deleted after the sale. The buyer is owed something the
    // store can no longer produce, and saying so is better than a broken link.
    if (!asset) return { kind: "asset_gone" as const };

    // A grant belongs to the store that sold it. Without this, a token from one
    // storefront would redeem through another's URL.
    if (asset.orgId !== store.orgId) return { kind: "not_found" as const };

    const refusal = checkRedeemable(grant);
    if (refusal) return { kind: "refused" as const, refusal, grant };

    const [updated] = await tx
      .update(downloadGrants)
      .set({
        downloadCount: grant.downloadCount + 1,
        lastDownloadedAt: new Date(),
      })
      .where(eq(downloadGrants.id, grant.id))
      .returning();

    /**
     * The G5 egress meter, written with the authorisation rather than after the
     * transfer — the transfer happens between the shopper and Supabase and is
     * never observable from here. It counts bytes *authorised*, which
     * over-counts an abandoned download. The over-count falls on Markii's own
     * cost accounting, never on a merchant's bill, which is why it is the
     * acceptable side to err on.
     */
    await tx.insert(downloadEvents).values({
      grantId: grant.id,
      orgId: asset.orgId,
      bytes: asset.sizeBytes,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    });

    return { kind: "ok" as const, asset, grant: updated };
  });

  if (outcome.kind === "not_found") throw notFound("Download");

  if (outcome.kind === "asset_gone") {
    return NextResponse.json(
      {
        error: {
          code: "GONE",
          message: "This file is no longer available from the store.",
          details: { resolution: "Contact the store — your purchase is still on record." },
        },
      },
      { status: 410 },
    );
  }

  if (outcome.kind === "refused") {
    return NextResponse.json(
      {
        error: {
          code: outcome.refusal.code.toUpperCase(),
          message: outcome.refusal.message,
          details: {
            downloadCount: outcome.grant.downloadCount,
            downloadLimit: outcome.grant.downloadLimit,
            expiresAt: outcome.grant.expiresAt?.toISOString() ?? null,
          },
        },
      },
      { status: outcome.refusal.code === "revoked" ? 403 : 410 },
    );
  }

  const signed = await signedDownloadUrl({
    path: outcome.asset.storagePath,
    downloadAs: outcome.asset.fileName,
  });

  if (!signed.ok) {
    /**
     * The counter was already incremented in the committed transaction above.
     * Giving the attempt back is the right call — a shopper must not lose one of
     * five downloads to our storage failing — and it is done as its own
     * statement rather than by rolling back, because the metering event is a
     * true record of what happened and should not vanish with it.
     */
    await db
      .update(downloadGrants)
      .set({ downloadCount: outcome.grant.downloadCount - 1 })
      .where(eq(downloadGrants.id, outcome.grant.id));

    return NextResponse.json(
      {
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "The download could not be prepared. This attempt has not been counted.",
          details: { reason: signed.message },
        },
      },
      { status: 502 },
    );
  }

  return NextResponse.redirect(signed.url, {
    status: 302,
    headers: {
      // A signed URL expires in minutes; a cached redirect would outlive it and
      // serve a dead link, or worse, let a shared cache hand it to someone else.
      "cache-control": "no-store, private",
    },
  });
});
