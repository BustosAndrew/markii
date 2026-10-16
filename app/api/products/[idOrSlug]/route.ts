import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { invokeAction } from "@/lib/actions";
import { intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, products, type Product } from "@/lib/db";
import { resolveProduct, serializeProductDetail } from "@/lib/queries";
import { productUpdateSchema } from "@/lib/validation";

export const GET = orgHandler(async (req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const product = await resolveProduct(idOrSlug, orgId, intParam(sp, "siteId"));
  return NextResponse.json(await serializeProductDetail(product));
});

/**
 * `PATCH /api/products/:idOrSlug` — delegates to `catalog.updateProduct` (§22
 * rule 1).
 *
 * This route wrote the catalog directly from v1 until 2026-10-15, so a product
 * edit had no audit row, no dry run and no undo — and no agent could propose
 * one, because a proposal *is* a dry run of a registry action. The contract is
 * unchanged: same fields, same refusals, same response.
 */
export const PATCH = orgHandler(async (req, { params, orgId, session }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const product = await resolveProduct(idOrSlug, orgId, intParam(sp, "siteId"));
  const input = productUpdateSchema.parse(await req.json());

  const outcome = await invokeAction<Product>(
    "catalog.updateProduct",
    { ...input, productId: product.id },
    { actor: session.actor },
  );
  return NextResponse.json(await serializeProductDetail(outcome.result!));
}, { permission: "catalog.write" });

export const DELETE = orgHandler(async (req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const product = await resolveProduct(idOrSlug, orgId, intParam(sp, "siteId"));

  // scrub references from sibling products' suggestions and add-ons
  const siblings = await db.select().from(products).where(eq(products.siteId, product.siteId));
  for (const s of siblings) {
    if (s.id === product.id) continue;
    const suggested = s.suggestedProductIds.filter((id) => id !== product.id);
    const addOns = s.addOns.filter((a) => a.productId !== product.id);
    if (suggested.length !== s.suggestedProductIds.length || addOns.length !== s.addOns.length) {
      await db
        .update(products)
        .set({ suggestedProductIds: suggested, addOns, updatedAt: new Date() })
        .where(eq(products.id, s.id));
    }
  }

  await db.delete(products).where(eq(products.id, product.id));
  return NextResponse.json({ deleted: true, id: product.id });
}, { permission: "catalog.write" });
