import { NextResponse } from "next/server";
import { notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { dashboardPost } from "@/lib/blog/queries";
import { resolveSite } from "@/lib/queries";

/** `GET /api/sites/:idOrSlug/blog/posts/:postId` — one post with its Markdown body, for the editor. */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug, postId } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const id = Number(postId);
    if (!Number.isInteger(id) || id < 1) throw notFound("Post");
    return NextResponse.json(await dashboardPost(site.id, id), { headers: { "cache-control": "no-store" } });
  },
  { permission: "cms.read" },
);
