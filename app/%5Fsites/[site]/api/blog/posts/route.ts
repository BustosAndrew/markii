import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { storefrontPosts } from "@/lib/blog/queries";
import { BLOG_PAGE_SIZE } from "@/lib/blog/rules";
import { postSummaryJson, READ_API_HEADERS } from "@/lib/storefront/read-api";
import { loadReadableSite } from "@/lib/storefront/read-api-server";

/**
 * `GET /api/blog/posts?page=&limit=` on a storefront host (D53) — the store's
 * live posts, newest first, as `/blog` lists them: `storefrontPosts`, the same
 * lookup the page uses. Live only — the read API never serves the preview, so
 * a draft or a scheduled post is absent until its time comes.
 *
 * `limit` defaults to `/blog`'s own page size and is clamped to 50; a bad
 * `page` or `limit` is the default, never a 400, like the product list. A
 * `page` past the last answers an empty list with the real `pages`, so a
 * client paging forward stops on `page >= pages` rather than on an error.
 */

const LIMIT_MAX = 50;

function positive(raw: string | null): number | null {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const GET = handler(async (req, { params }) => {
  const { site } = await params;
  const data = await loadReadableSite(site);
  const sp = new URL(req.url).searchParams;
  const limit = Math.min(positive(sp.get("limit")) ?? BLOG_PAGE_SIZE, LIMIT_MAX);
  const { posts, total, page, pages } = await storefrontPosts(data.site.id, { page: positive(sp.get("page")) ?? 1, limit });
  return NextResponse.json(
    { posts: posts.map((p) => postSummaryJson(data, p)), page, pages, total },
    { headers: READ_API_HEADERS },
  );
});
