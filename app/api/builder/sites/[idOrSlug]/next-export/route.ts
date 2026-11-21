import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { nextExportFiles } from "@/lib/builder/next-export";
import { PRIVATE_BUCKET, signedDownloadUrl, uploadFile } from "@/lib/storage";
import { resolveSite, storefrontUrl } from "@/lib/queries";
import { zip } from "@/lib/zip";

/**
 * `POST /api/builder/sites/:idOrSlug/next-export` (D53) — the storefront as a
 * Next.js app the merchant owns, as a zip behind a five-minute download link.
 *
 * The app reads the store **live** through the storefront read API, so it
 * holds no catalogue or design of its own and needs no re-export when either
 * changes. It is Apache 2.0 throughout (`lib/builder/next-export.ts`) and
 * carries no secret: the storefront key for members-only sales is the
 * merchant's to set in their host's environment.
 *
 * Written to storage like a theme export, one file per store. `cms.read`: the
 * zip holds the public renderer and the store's public address — nothing that
 * role cannot already see. **A route, not an action**: it changes nothing.
 */
export const POST = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const url = storefrontUrl(site);
    const files = nextExportFiles({ slug: site.slug, name: site.name, url });
    const archive = zip(files);

    const path = `${orgId}/next-exports/${site.id}.zip`;
    const stored = await uploadFile({ bucket: PRIVATE_BUCKET, path, body: archive, contentType: "application/zip", upsert: true });
    if (!stored.ok) {
      throw new ApiError(
        stored.code === "configuration_required" ? "CONFIGURATION_REQUIRED" : "UPSTREAM_ERROR",
        stored.code === "configuration_required" ? 503 : 502,
        "The export could not be stored for download.",
        { reason: stored.code },
      );
    }
    const link = await signedDownloadUrl({ path, downloadAs: `${site.slug}-storefront.zip` });
    if (!link.ok) throw new ApiError("UPSTREAM_ERROR", 502, "The export was stored but no download link could be made. Try again.", { reason: link.code });

    return NextResponse.json(
      {
        url: link.url,
        expiresAt: link.expiresAt.toISOString(),
        files: files.length,
        bytes: archive.length,
        storeUrl: url,
        /**
         * The export reads the live store, so a store still in draft or paused
         * exports fine and shows nothing until it is live. Said here rather
         * than discovered after a deploy. (A billing hold halts it the same
         * way, and is shown wherever the dashboard shows standing.)
         */
        storeLive: site.status === "live",
      },
      { status: 201 },
    );
  },
  { permission: "cms.read" },
);
