import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { contentGateFor } from "@/lib/commerce/memberships";
import { publishedPage } from "@/lib/storefront";
import { pageJson, READ_API_HEADERS } from "@/lib/storefront/read-api";
import { loadReadableSite } from "@/lib/storefront/read-api-server";

/**
 * `GET /api/pages/{handle}` on a storefront host (D53, §18.9) — one published
 * builder page: its tree, title and SEO, as `/pages/{handle}` (or `/` for
 * `home`) draws it. Published only, like the rest of the read API.
 *
 * It exists for **members-only pages**, whose tree `GET /api/store` withholds.
 * Such a page answers `locked: true` and `tree: null` unless the caller holds
 * the tier — a signed-in shopper on this host, or an exported store's server
 * with the storefront secret key and `Markii-Shopper-Email` — and is
 * `private, no-store` either way, since the answer depends on who asks. A
 * public page answers like the rest of the read API.
 */
export const GET = handler(async (_req, { params }) => {
  const { site, handle } = await params;
  const data = await loadReadableSite(site);
  const page = await publishedPage(data.site.id, handle);
  if (!page) throw notFound("Page");
  if (page.requiresTierId == null) return NextResponse.json(pageJson(data, page), { headers: READ_API_HEADERS });

  const gate = await contentGateFor(data.site.id, page.requiresTierId);
  return NextResponse.json(pageJson(data, page, gate), {
    headers: { ...READ_API_HEADERS, "cache-control": "private, no-store" },
  });
});
