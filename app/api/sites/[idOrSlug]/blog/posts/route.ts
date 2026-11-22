import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { dashboardPosts } from "@/lib/blog/queries";
import { resolveSite } from "@/lib/queries";

/**
 * `GET /api/sites/:idOrSlug/blog/posts` — every post, any status, drafts first
 * then newest. `?q=` matches title or handle; `?status=draft|scheduled|published`;
 * `?limit=` (50, max 200) and `?offset=`. Status is derived as of this request.
 * Writes are the `blog.*` actions.
 */
export const GET = orgHandler(
  async (req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const result = await dashboardPosts(site.id, {
      q: url.searchParams.get("q")?.trim() || undefined,
      status: status && ["draft", "scheduled", "published"].includes(status) ? status : undefined,
      limit: Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200),
      offset: Math.max(Number(url.searchParams.get("offset")) || 0, 0),
    });
    return NextResponse.json({ siteId: site.id, ...result }, { headers: { "cache-control": "no-store" } });
  },
  { permission: "cms.read" },
);
