import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { listSubmissions } from "@/lib/forms/queries";
import { resolveSite } from "@/lib/queries";

/**
 * `GET /api/sites/:idOrSlug/form-submissions` — what shoppers sent, newest
 * first. Customer data, so `commerce.read` like customers — not `cms.read`.
 * `?form={handle}` (a deleted form's submissions are still found by it),
 * `?q=` (the sender's email or any answer), `?limit=` (50, max 200), `?offset=`.
 * Kept permanently; `forms.deleteSubmission` erases one.
 */
export const GET = orgHandler(
  async (req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const url = new URL(req.url);
    const result = await listSubmissions(site.id, {
      form: url.searchParams.get("form")?.trim() || undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
      limit: Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200),
      offset: Math.max(Number(url.searchParams.get("offset")) || 0, 0),
    });
    return NextResponse.json({ siteId: site.id, ...result }, { headers: { "cache-control": "no-store" } });
  },
  { permission: "commerce.read" },
);
