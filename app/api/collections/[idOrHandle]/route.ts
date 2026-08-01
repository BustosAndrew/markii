import { NextResponse } from "next/server";
import { intParam, notFound, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { membersOf, resolveCollection } from "@/lib/commerce/collection-queries";
import { serializeProducts } from "@/lib/queries";

/**
 * `GET /api/collections/:idOrHandle` — the collection and its resolved members
 * (§18.2).
 *
 * Automated collections evaluate their rules **at read time**. A materialised
 * membership goes stale the moment a price or stock level changes, and an
 * "Under £20" collection listing a £30 product is a worse failure than a slower
 * query.
 *
 * `PATCH`/`DELETE` go through `catalog.updateCollection` / `catalog.deleteCollection`.
 */
export const GET = orgHandler(async (req, { params, orgId }) => {
  const { idOrHandle } = await params;
  const sp = new URL(req.url).searchParams;
  const { page, limit, offset } = pagination(sp);

  const collection = await resolveCollection(idOrHandle, orgId, intParam(sp, "siteId"));
  if (!collection) throw notFound("Collection");

  const members = await membersOf(collection, limit, offset);

  return NextResponse.json({
    ...collection,
    publishedAt: collection.publishedAt?.toISOString() ?? null,
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
    products: {
      items: await serializeProducts(members),
      page,
      limit,
    },
  });
});
