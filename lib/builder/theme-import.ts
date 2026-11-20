import "server-only";

import { z } from "zod";
import { ApiError } from "@/lib/api";
import type { Actor } from "@/lib/actions/types";
import { PRIVATE_BUCKET, downloadFile } from "@/lib/storage";
import { themeFileSchema, type ThemeFile } from "./theme-package";

/**
 * Where an uploaded theme package waits to be imported (D53), in the private
 * bucket. Under the actor's own prefix, so the import step can only ever read
 * what the same person uploaded.
 *
 * **A new path for every upload, never a reused slot.** A read of an object
 * URL can be answered with bytes the object no longer holds — verified
 * 2026-11-19: after a successful delete, a `GET` of the same URL from the
 * server still returned the old file, with `cache: "no-store"` and
 * `cache-control: no-cache` both set, while the same URL with a query string
 * answered "not found". With one slot per person, uploading a corrected file
 * could import the previous one. A fresh id per upload makes every read a URL
 * nothing has ever cached.
 */
export const uploadIdSchema = z.string().uuid();

export function themeImportPath(orgId: string, siteId: number, actor: Pick<Actor, "type" | "id">, uploadId: string): string {
  return `${orgId}/theme-imports/${siteId}/${actor.type}-${actor.id}/${uploadIdSchema.parse(uploadId)}.json`;
}

/** 25 MB of images is ~34 MB as base64, plus the trees. */
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** Read and check an uploaded theme file. Its images are verified separately, when stored. */
export async function readThemeFile(path: string): Promise<ThemeFile> {
  const got = await downloadFile(PRIVATE_BUCKET, path);
  if (!got.ok) {
    if (got.code === "configuration_required") {
      throw new ApiError("CONFIGURATION_REQUIRED", 503, "File storage is not configured, so a theme package cannot be read.", {
        resolution: got.resolution,
      });
    }
    throw new ApiError("NOT_FOUND", 404, "No theme package has been uploaded for this import. Upload the file first.", {
      reason: "no_upload",
    });
  }
  if (got.bytes.length > MAX_FILE_BYTES) {
    throw new ApiError("CONFLICT", 409, "This theme package file is too large.", { reason: "package_too_large" });
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(got.bytes));
  } catch {
    throw new ApiError("VALIDATION_ERROR", 400, "This file is not a theme package — it is not valid JSON.", { reason: "not_json" });
  }
  const parsed = themeFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", 400, "This file is not a Markii theme package, or it is from a version this store cannot read.", {
      reason: "invalid_package",
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}
