import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { pageParams, productJson, READ_API_HEADERS } from "@/lib/storefront/read-api";
import { loadReadableSite } from "@/lib/storefront/read-api-server";

/**
 * `GET /api/products?limit=&offset=` on a storefront host (D53) — the enabled
 * catalogue, oldest first so pages are stable while a merchant adds products.
 * `next` is the offset of the following page, or null at the end.
 */
export const GET = handler(async (req, { params }) => {
  const data = await loadReadableSite((await params).site);
  const { limit, offset } = pageParams(new URL(req.url).searchParams);
  const enabled = data.prods.filter((p) => p.enabled).sort((a, b) => a.id - b.id);
  const page = enabled.slice(offset, offset + limit);
  return NextResponse.json(
    {
      total: enabled.length,
      limit,
      offset,
      next: offset + limit < enabled.length ? offset + limit : null,
      products: page.map((p) => productJson(data, p)),
    },
    { headers: READ_API_HEADERS },
  );
});
