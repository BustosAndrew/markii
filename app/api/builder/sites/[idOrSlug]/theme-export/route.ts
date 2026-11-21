import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { packageSourceRows } from "@/lib/builder/queries";
import { bundleImages } from "@/lib/builder/theme-assets";
import { packageFromDesign } from "@markii/renderer/theme-package";
import type { NodeInput } from "@markii/renderer/tree";
import { PRIVATE_BUCKET, signedDownloadUrl, uploadFile } from "@/lib/storage";
import { resolveSite } from "@/lib/queries";

/**
 * `POST /api/builder/sites/:idOrSlug/theme-export` (D53) — the store's design
 * as a theme package file, with its own images inside, behind a five-minute
 * download link.
 *
 * **Written to storage, never streamed back**: a design with a few hero images
 * is past the 4.5 MB a function may return, and serving files through a
 * function is what G5 forbids. One file per store — each export replaces the
 * last — so exports cannot pile up in the private bucket.
 *
 * **A route, not an action**: it changes nothing anyone sees, and its result
 * is a download link, which does not belong in the audit log. `cms.read`,
 * because the file holds nothing `GET /api/builder/sites/:id` does not already
 * show that role. Head code is left out (`packages/renderer/src/theme-package.ts`).
 */
const body = z.object({ source: z.enum(["draft", "published"]).default("draft") }).strict();

export const POST = orgHandler(
  async (req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const raw = await req.text();
    const { source } = body.parse(raw ? JSON.parse(raw) : {});
    const site = await resolveSite(idOrSlug, orgId);

    const rows = await packageSourceRows(site.id);
    if (!rows) throw new ApiError("CONFLICT", 409, "This store's design has not been started, so there is nothing to export.", { reason: "no_design" });
    const pkg = packageFromDesign({
      name: site.name,
      source,
      publishedThemeId: site.themeId,
      design: rows.design,
      documents: rows.documents,
      savedBlocks: rows.savedBlocks.map((b) => ({ name: b.name, node: b.node as NodeInput })),
    });
    if (!pkg) {
      throw new ApiError("CONFLICT", 409, "Nothing has been published yet. Export the draft instead.", {
        reason: "nothing_published",
        resolution: 'Send source: "draft".',
      });
    }

    const { file, report } = await bundleImages(pkg, orgId);
    const path = `${orgId}/theme-exports/${site.id}.json`;
    const stored = await uploadFile({
      bucket: PRIVATE_BUCKET,
      path,
      body: Buffer.from(JSON.stringify(file)),
      contentType: "application/json",
      upsert: true,
    });
    if (!stored.ok) {
      throw new ApiError(
        stored.code === "configuration_required" ? "CONFIGURATION_REQUIRED" : "UPSTREAM_ERROR",
        stored.code === "configuration_required" ? 503 : 502,
        "The theme package could not be stored for download.",
        { reason: stored.code },
      );
    }
    const link = await signedDownloadUrl({ path, downloadAs: `${site.slug}-theme.json` });
    if (!link.ok) throw new ApiError("UPSTREAM_ERROR", 502, "The theme package was stored but no download link could be made. Try again.", { reason: link.code });

    const headHtml = source === "published" ? rows.design.publishedHeadHtml : rows.design.draftHeadHtml;
    return NextResponse.json(
      {
        url: link.url,
        expiresAt: link.expiresAt.toISOString(),
        source,
        documents: file.documents.length,
        savedBlocks: file.savedBlocks.length,
        images: report,
        headCodeLeftOut: headHtml !== "",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
  { permission: "cms.read" },
);
