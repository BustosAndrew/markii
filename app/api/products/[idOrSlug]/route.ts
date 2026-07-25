import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, conflict, handler, intParam, notFound } from "@/lib/api";
import { categories, db, products, sites } from "@/lib/db";
import { resolveProduct, serializeProductDetail, uniqueProductSlug } from "@/lib/queries";
import { productUpdateSchema } from "@/lib/validation";

export const GET = handler(async (req, { params }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const product = await resolveProduct(idOrSlug, intParam(sp, "siteId"));
  return NextResponse.json(await serializeProductDetail(product));
});

export const PATCH = handler(async (req, { params }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const product = await resolveProduct(idOrSlug, intParam(sp, "siteId"));
  const input = productUpdateSchema.parse(await req.json());

  const siteChanged = input.siteId != null && input.siteId !== product.siteId;
  const targetSiteId = input.siteId ?? product.siteId;
  if (siteChanged) {
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, targetSiteId)).limit(1);
    if (!site) throw notFound("Target site");
  }

  // reassigning site clears the category unless a valid one on the target site is sent along
  const categoryId = siteChanged
    ? (input.categoryId ?? null)
    : input.categoryId !== undefined
      ? input.categoryId
      : product.categoryId;
  if (categoryId != null) {
    const [cat] = await db
      .select({ id: categories.id, siteId: categories.siteId })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!cat) throw notFound("Category");
    if (cat.siteId !== targetSiteId) throw badRequest("category belongs to a different site");
  }

  let slug = input.slug ?? product.slug;
  if (input.slug && (input.slug !== product.slug || siteChanged)) {
    const [taken] = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(eq(products.siteId, targetSiteId), eq(products.slug, slug), ne(products.id, product.id)),
      )
      .limit(1);
    if (taken) throw conflict(`product slug "${slug}" already exists on this site`);
  } else if (siteChanged) {
    slug = await uniqueProductSlug(targetSiteId, product.slug);
  }

  const [row] = await db
    .update(products)
    .set({ ...input, siteId: targetSiteId, categoryId, slug, updatedAt: new Date() })
    .where(eq(products.id, product.id))
    .returning();
  return NextResponse.json(await serializeProductDetail(row));
});

export const DELETE = handler(async (req, { params }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const product = await resolveProduct(idOrSlug, intParam(sp, "siteId"));

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
});
