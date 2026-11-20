import { NextResponse } from "next/server";
import { z } from "zod";
import { invokeAction } from "@/lib/actions";
import { orgHandler } from "@/lib/auth/handler";
import { unbundleImages } from "@/lib/builder/theme-assets";
import { readThemeFile, themeImportPath, uploadIdSchema } from "@/lib/builder/theme-import";
import { resolveSite } from "@/lib/queries";
import { PRIVATE_BUCKET, deleteFile } from "@/lib/storage";

/**
 * `POST /api/builder/sites/:idOrSlug/theme-import` (D53) — step 2: import the
 * theme package the caller uploaded through `…/theme-import/upload-url`,
 * named by its `uploadId`.
 *
 * Reads the file, checks every bundled image (hash, size, file signature),
 * stores them in this org's `public-media`, rewrites the references, and then
 * hands the package to **`builder.importTheme`** — so the write itself is a
 * registry action like any other, with its permission, its `high` tier (a
 * person only), its audit row and its checks. `?dryRun=1` stores nothing and
 * returns what the import would do; the upload stays for the real import.
 *
 * Images are stored *before* the action runs, because storage is not part of
 * the transaction. A refused import can therefore leave images behind — at
 * content-addressed paths, so a retry reuses them rather than duplicating.
 */
const body = z.object({ uploadId: uploadIdSchema, discardUnpublished: z.boolean().default(false) }).strict();

export const POST = orgHandler(
  async (req, { params, orgId, session }) => {
    const { idOrSlug } = await params;
    const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
    const raw = await req.text();
    const { uploadId, discardUnpublished } = body.parse(raw ? JSON.parse(raw) : {});
    const site = await resolveSite(idOrSlug, orgId);

    const path = themeImportPath(orgId, site.id, session.actor, uploadId);
    const file = await readThemeFile(path);
    const { pkg, report } = await unbundleImages(file, orgId, { store: !dryRun });

    const outcome = await invokeAction(
      "builder.importTheme",
      { siteId: site.id, package: pkg, discardUnpublished },
      { actor: session.actor, dryRun },
    );
    if (!dryRun) await deleteFile(PRIVATE_BUCKET, path);
    return NextResponse.json({ ...outcome, images: report }, { headers: { "cache-control": "no-store" } });
  },
  { permission: "cms.write" },
);
