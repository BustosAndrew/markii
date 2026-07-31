import { NextResponse } from "next/server";
import { ApiError, badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { importFromCsv, importFromUrl, type ImportResult } from "@/lib/importer";
import { importUrlSchema } from "@/lib/validation";

/**
 * Phase 1 of the CSV/scrape popup: parse only, nothing is saved.
 * Send either multipart form-data with a `file` (CSV) or JSON `{ "url": "..." }`.
 */
export const POST = orgHandler(async (req) => {
  const contentType = req.headers.get("content-type") ?? "";
  let result: ImportResult;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw badRequest('multipart field "file" is required');
    result = importFromCsv(await file.text());
  } else {
    const { url } = importUrlSchema.parse(await req.json());
    result = await importFromUrl(url);
  }

  if (result.imported.length === 0) {
    throw new ApiError(
      "IMPORT_FAILED",
      422,
      result.failed[0]?.reason ?? "nothing could be imported",
      result.failed,
    );
  }
  return NextResponse.json(result);
});
