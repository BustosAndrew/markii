import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { themeImportPath } from "@/lib/builder/theme-import";
import { resolveSite } from "@/lib/queries";
import { signedUploadUrl } from "@/lib/storage";

/**
 * `POST /api/builder/sites/:idOrSlug/theme-import/upload-url` (D53) — step 1 of
 * importing a theme package file: a one-time URL the browser `PUT`s the file to,
 * straight into private storage. A package with its images is past the 4.5 MB
 * request body a function accepts, so the file cannot come through a route.
 *
 * **Each upload gets its own path under the caller's prefix** (`uploadId`), so
 * a second staff member can never import a file someone else uploaded, and a
 * re-upload can never be read back as the file it replaced
 * (`lib/builder/theme-import.ts`). Step 2 is `POST …/theme-import` with the
 * same `uploadId`.
 */
export const POST = orgHandler(
  async (_req, { params, orgId, session }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const uploadId = crypto.randomUUID();
    const signed = await signedUploadUrl(themeImportPath(orgId, site.id, session.actor, uploadId));
    if (!signed.ok) {
      throw new ApiError(
        signed.code === "configuration_required" ? "CONFIGURATION_REQUIRED" : "UPSTREAM_ERROR",
        signed.code === "configuration_required" ? 503 : 502,
        "An upload link for the theme package could not be made.",
        { reason: signed.code },
      );
    }
    return NextResponse.json(
      {
        uploadId,
        uploadUrl: signed.url,
        method: "PUT",
        headers: { "content-type": "application/json", "x-upsert": "true" },
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
  { permission: "cms.write" },
);
