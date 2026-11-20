import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { storefrontMembersOf } from "@/lib/storefront/collections";
import { collectionJson, PRODUCT_PAGE_MAX, productJson, READ_API_HEADERS } from "@/lib/storefront/read-api";
import { loadReadableSite } from "@/lib/storefront/read-api-server";

/**
 * `GET /api/collections/{handle}?limit=` on a storefront host (D53) — a
 * published collection and its products in the merchant's order, rules
 * evaluated, enabled only: `storefrontMembersOf`, the same lookup the
 * collection page and the renderer's `membersOf` use. An unpublished
 * collection is a 404, exactly as its page is.
 */
export const GET = handler(async (req, { params }) => {
  const { site, handle } = await params;
  const data = await loadReadableSite(site);
  const collection = data.colls.find((c) => c.handle === handle);
  if (!collection) throw notFound("Collection");
  const raw = Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, PRODUCT_PAGE_MAX) : PRODUCT_PAGE_MAX;
  const members = await storefrontMembersOf(collection, limit);
  return NextResponse.json(
    { collection: collectionJson(data, collection), products: members.map((p) => productJson(data, p)) },
    { headers: READ_API_HEADERS },
  );
});
