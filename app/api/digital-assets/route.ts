import { and, asc, count, eq, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ApiError, badRequest, intParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { mediaQuotaFrom, mediaUsageFor, storageAllows } from "@/lib/commerce/media-usage";
import { db, digitalAssets, sites } from "@/lib/db";
import { entitlementsFor } from "@/lib/plans";
import { ownSites } from "@/lib/tenancy";
import { PRIVATE_BUCKET, isStorageConfigured, uploadFile } from "@/lib/storage";

/**
 * `/api/digital-assets` (§18.8) — the files a merchant sells.
 *
 * **`POST` is a route, not a registry action, and that is deliberate.** Actions
 * take JSON and write their input to an audit table; pushing a 2 GB course file
 * through that as base64 would be absurd. So the bytes land here, and everything
 * a merchant then *does* with the asset — attach, detach, delete, set a download
 * policy — goes through `delivery.*` actions (§22 rule 1). The upload creates a
 * file; it does not change what any product sells.
 *
 * Files go to the **private** bucket and no URL is ever returned. Access is a
 * signed link minted per download from a paid grant — see `lib/storage` and
 * `/_sites/:site/download/:token`.
 */

/**
 * 2 GB, matching what Supabase Storage accepts in one request. Larger files
 * need resumable uploads (TUS), which is a real gap for video sellers — and
 * G5 says not to host video anyway, so the honest answer to "my 8 GB course
 * won't upload" is an embed integration, not a bigger limit here.
 */
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export const GET = orgHandler(
  async (req, { orgId, session }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);

    const conds: SQL[] = [eq(digitalAssets.orgId, orgId)];
    const siteId = intParam(sp, "siteId");
    if (siteId != null) conds.push(eq(digitalAssets.siteId, siteId));
    const where = and(...conds);

    const [totalRow] = await db.select({ c: count() }).from(digitalAssets).where(where);
    const rows = await db
      .select()
      .from(digitalAssets)
      .where(where)
      .orderBy(asc(digitalAssets.id))
      .limit(limit)
      .offset(offset);

    return NextResponse.json({
      items: rows.map((a) => ({
        ...a,
        // No URL, by design. A durable address for a paid file is one leak away
        // from being the product.
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      })),
      total: Number(totalRow?.c ?? 0),
      page,
      limit,
      /** Usage against the plan's G5 allowance — storage enforced at upload, delivery reported. */
      usage: await mediaUsageFor(db, orgId, {
        quota: mediaQuotaFrom(entitlementsFor(session.org).media),
      }),
    });
  },
  { permission: "catalog.read" },
);

export const POST = orgHandler(
  async (req, { orgId, session }) => {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw badRequest('multipart field "file" is required');
    if (file.size === 0) throw badRequest("file is empty");
    if (file.size > MAX_BYTES) {
      throw badRequest(
        `file exceeds the ${Math.round(MAX_BYTES / 1024 ** 3)} GB limit. Markii does not host ` +
          "video — use a Mux, Vimeo, or YouTube embed instead.",
      );
    }

    const siteIdRaw = form.get("siteId");
    let siteId: number | null = null;
    if (typeof siteIdRaw === "string" && siteIdRaw !== "") {
      siteId = Number(siteIdRaw);
      if (!Number.isInteger(siteId)) throw badRequest("siteId must be a number");
      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, siteId), ownSites(orgId)))
        .limit(1);
      if (!site) throw badRequest("That store does not belong to this organization");
    }

    if (!isStorageConfigured()) {
      return NextResponse.json(
        {
          error: {
            code: "CONFIGURATION_REQUIRED",
            message: "File storage is not configured, so this file cannot be stored.",
            details: {
              resolution:
                "File storage is not configured on this deployment. Contact your Markii admin.",
            },
          },
        },
        { status: 503 },
      );
    }

    /**
     * The G5 storage allowance, checked **before** any byte is stored — a
     * refusal after the upload would pay for the transfer and then delete it.
     *
     * Two concurrent uploads can each see room for themselves and together
     * overshoot. That is accepted rather than locked against: the overshoot is
     * bounded by one file (`MAX_BYTES`), costs cents of storage, and the next
     * upload is refused. A lock would serialise every upload an org makes for
     * the sake of that.
     */
    const quota = mediaQuotaFrom(entitlementsFor(session.org).media);
    const before = await mediaUsageFor(db, orgId, { quota });
    const room = storageAllows(before.storageBytes, file.size, quota);
    if (!room.allowed) {
      throw new ApiError(
        "QUOTA_EXCEEDED",
        409,
        `This file would take your stored files past your plan's ` +
          `${Math.round(quota.storageBytes / 1024 ** 3)} GB storage allowance.`,
        {
          quota: "storage",
          storageBytes: room.storageBytes,
          quotaBytes: room.quotaBytes,
          fileBytes: room.fileBytes,
          overByBytes: room.overByBytes,
          resolution:
            "Delete files you no longer sell, or move to a plan with more storage. Files already " +
            "stored keep serving to your customers either way.",
        },
      );
    }

    const label = typeof form.get("label") === "string" ? (form.get("label") as string) : null;

    /**
     * Keyed by org and a random id, never by filename. Two merchants both
     * uploading `course.zip` must not collide, and a guessable object key would
     * make the private bucket's protection depend on nobody guessing.
     */
    const storagePath = `${orgId}/${crypto.randomUUID()}`;

    const uploaded = await uploadFile({
      bucket: PRIVATE_BUCKET,
      path: storagePath,
      body: await file.arrayBuffer(),
      contentType: file.type || "application/octet-stream",
    });

    if (!uploaded.ok) {
      return NextResponse.json(
        { error: { code: "UPLOAD_FAILED", message: uploaded.message, details: uploaded } },
        { status: uploaded.code === "configuration_required" ? 503 : 502 },
      );
    }

    const [row] = await db
      .insert(digitalAssets)
      .values({
        orgId,
        siteId,
        storagePath,
        fileName: file.name || "download",
        contentType: file.type || "application/octet-stream",
        sizeBytes: uploaded.bytes,
        label,
      })
      .returning();

    return NextResponse.json(
      {
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        usage: await mediaUsageFor(db, orgId, { quota }),
      },
      { status: 201 },
    );
  },
  { permission: "catalog.write" },
);
