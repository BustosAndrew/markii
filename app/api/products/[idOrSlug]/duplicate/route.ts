import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, handler, intParam, notFound } from "@/lib/api";
import { categories, db, products, sites } from "@/lib/db";
import { resolveProduct, serializeProductDetail, uniqueProductSlug } from "@/lib/queries";

const bodySchema = z
  .object({
    siteId: z.number().int().positive().optional(),
    categoryId: z.number().int().positive().nullish(),
  })
  .default({});

export const POST = handler(async (req, { params }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const product = await resolveProduct(idOrSlug, intParam(sp, "siteId"));

  const raw = await req.text();
  const body = bodySchema.parse(raw ? JSON.parse(raw) : undefined);
  const targetSiteId = body.siteId ?? product.siteId;
  if (targetSiteId !== product.siteId) {
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, targetSiteId)).limit(1);
    if (!site) throw notFound("Target site");
  }

  let categoryId: number | null;
  if (body.categoryId !== undefined) categoryId = body.categoryId ?? null;
  else categoryId = targetSiteId === product.siteId ? product.categoryId : null;
  if (categoryId != null) {
    const [cat] = await db
      .select({ id: categories.id, siteId: categories.siteId })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!cat) throw notFound("Category");
    if (cat.siteId !== targetSiteId) throw badRequest("category belongs to a different site");
  }

  const slugBase = targetSiteId === product.siteId ? `${product.slug}-copy` : product.slug;
  const [copy] = await db
    .insert(products)
    .values({
      siteId: targetSiteId,
      categoryId,
      name: product.name,
      slug: await uniqueProductSlug(targetSiteId, slugBase),
      description: product.description,
      priceCents: product.priceCents,
      currency: product.currency,
      sku: null, // SKUs identify one sellable item; copies get their own
      stock: product.stock,
      images: product.images,
      enabled: product.enabled,
      suggestedProductIds: targetSiteId === product.siteId ? product.suggestedProductIds : [],
      addOns: targetSiteId === product.siteId ? product.addOns : [],
    })
    .returning();

  return NextResponse.json(await serializeProductDetail(copy), { status: 201 });
});
