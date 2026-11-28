import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { storefrontPost } from "@/lib/blog/queries";
import { contentGateFor } from "@/lib/commerce/memberships";
import { postJson, READ_API_HEADERS } from "@/lib/storefront/read-api";
import { loadReadableSite } from "@/lib/storefront/read-api-server";

/**
 * `GET /api/blog/posts/{handle}` on a storefront host (D53) — one live post as
 * `/blog/{handle}` shows it, body as the Markdown subset
 * `@markii/renderer/article` draws. A draft, a scheduled post and a handle the
 * store never had are the same 404, exactly as the page answers — the read API
 * must not tell anyone a post is coming.
 *
 * **A members-only post (§18.9)** answers `locked: true` with an empty body,
 * unless the caller holds the tier: a signed-in shopper on this host, or an
 * exported store's server presenting the storefront secret key and
 * `Markii-Shopper-Email` (`currentCustomer` resolves both). Its answer depends
 * on who asks, so it is `private, no-store` and never shared from a cache —
 * public or not, a members-only post's response must not be one a CDN could
 * hand a member's copy to the next visitor.
 */
export const GET = handler(async (_req, { params }) => {
  const { site, handle } = await params;
  const data = await loadReadableSite(site);
  const post = await storefrontPost(data.site.id, handle);
  if (!post) throw notFound("Post");
  if (post.requiresTierId == null) return NextResponse.json(postJson(data, post), { headers: READ_API_HEADERS });

  const gate = await contentGateFor(data.site.id, post.requiresTierId);
  return NextResponse.json(postJson(data, post, gate), {
    headers: { ...READ_API_HEADERS, "cache-control": "private, no-store" },
  });
});
