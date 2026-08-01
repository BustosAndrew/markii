import { NextResponse } from "next/server";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { PUBLIC_BUCKET, isStorageConfigured, uploadFile } from "@/lib/storage";

/**
 * `POST /api/uploads` (§4) — product images, to Supabase Storage (D6).
 *
 * **This previously wrote `public/uploads` whenever `BLOB_READ_WRITE_TOKEN` was
 * absent, which silently broke every deployment.** Vercel's filesystem is
 * ephemeral: the upload appeared to succeed, returned a `/uploads/…` URL, and
 * the image 404'd as soon as the instance recycled. A missing credential now
 * produces an explicit *configuration required* rather than a URL that will not
 * resolve — the no-fabrication rule applied to a success response.
 *
 * Images go in the **public** bucket on purpose. They are referenced from
 * storefront HTML and JSON-LD, so a signed URL would expire out of a cached page
 * and break agent legibility. Files a merchant *sells* live in a private bucket
 * and are never public — see `lib/storage`.
 *
 * The response is still `{ url }` and the dashboard still treats it as opaque
 * (`CLAUDE.md`), which is exactly why this swap needs no frontend change.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export const POST = orgHandler(async (req, { orgId }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest('multipart field "file" is required');
  if (file.size > MAX_BYTES) throw badRequest("file exceeds the 5 MB limit");

  const ext = EXT_BY_TYPE[file.type];
  if (!ext) throw badRequest("only png, jpg or webp images are allowed");

  if (!isStorageConfigured()) {
    return NextResponse.json(
      {
        error: {
          code: "CONFIGURATION_REQUIRED",
          message: "File storage is not configured, so this upload cannot be stored.",
          details: {
            resolution:
              "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only, never " +
              "a NEXT_PUBLIC_ variable). See .env.example.",
          },
        },
      },
      { status: 503 },
    );
  }

  // Keyed by org so one tenant's uploads are never in another's prefix, and a
  // per-org storage total is a prefix listing rather than a full scan.
  const path = `${orgId}/${crypto.randomUUID()}.${ext}`;

  const result = await uploadFile({
    bucket: PUBLIC_BUCKET,
    path,
    body: await file.arrayBuffer(),
    contentType: file.type,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: { code: "UPLOAD_FAILED", message: result.message, details: result } },
      { status: result.code === "configuration_required" ? 503 : 502 },
    );
  }

  return NextResponse.json({ url: result.url, path: result.path }, { status: 201 });
});
