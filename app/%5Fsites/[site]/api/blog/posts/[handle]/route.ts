import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { storefrontPost } from "@/lib/blog/queries";
import { postJson, READ_API_HEADERS } from "@/lib/storefront/read-api";
import { loadReadableSite } from "@/lib/storefront/read-api-server";

/**
 * `GET /api/blog/posts/{handle}` on a storefront host (D53) — one live post as
 * `/blog/{handle}` shows it, body as the Markdown subset
 * `@markii/renderer/article` draws. A draft, a scheduled post and a handle the
 * store never had are the same 404, exactly as the page answers — the read API
 * must not tell anyone a post is coming.
 */
export const GET = handler(async (_req, { params }) => {
  const { site, handle } = await params;
  const data = await loadReadableSite(site);
  const post = await storefrontPost(data.site.id, handle);
  if (!post) throw notFound("Post");
  return NextResponse.json(postJson(data, post), { headers: READ_API_HEADERS });
});
