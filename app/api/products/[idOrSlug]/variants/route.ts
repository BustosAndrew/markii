import { NextResponse } from "next/server";
import { intParam, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { variantsForProduct } from "@/lib/commerce/queries";
import { resolveProduct } from "@/lib/queries";

/**
 * `GET /api/products/:idOrSlug/variants` — a product's variant matrix and its
 * option axes, with inventory levels derived from the ledger (§18.1).
 *
 * There is no `POST` here. Variants are created by regenerating the matrix
 * through `catalog.setProductOptions`, because a variant that does not
 * correspond to an option combination has no coherent identity — and every
 * mutation goes through the action registry (§22 rule 1).
 */
export const GET = orgHandler(async (req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const product = await resolveProduct(idOrSlug, orgId, intParam(sp, "siteId"));

  const result = await variantsForProduct(orgId, product.id);
  if (!result) throw notFound("Product");

  return NextResponse.json(result);
});
