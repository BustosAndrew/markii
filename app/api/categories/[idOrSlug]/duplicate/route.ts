import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { intParam, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { ownSites } from "@/lib/tenancy";
import { categories, db, products, sites } from "@/lib/db";
import {
  resolveCategory,
  serializeCategoryDetail,
  uniqueCategorySlug,
  uniqueProductSlug,
} from "@/lib/queries";

const bodySchema = z
  .object({
    siteId: z.number().int().positive().optional(),
    includeProducts: z.boolean().default(true),
  })
  .default({ includeProducts: true });

export const POST = orgHandler(async (req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const category = await resolveCategory(idOrSlug, orgId, intParam(sp, "siteId"));

  const raw = await req.text();
  const { siteId, includeProducts } = bodySchema.parse(raw ? JSON.parse(raw) : undefined);
  const targetSiteId = siteId ?? category.siteId;
  if (targetSiteId !== category.siteId) {
    const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, targetSiteId), ownSites(orgId))).limit(1);
    if (!site) throw notFound("Target site");
  }

  const slugBase = targetSiteId === category.siteId ? `${category.slug}-copy` : category.slug;
  const slug = await uniqueCategorySlug(targetSiteId, slugBase);

  const [copy] = await db
    .insert(categories)
    .values({
      siteId: targetSiteId,
      parentId: targetSiteId === category.siteId ? category.parentId : null,
      name: category.name,
      slug,
      description: category.description,
      imageUrl: category.imageUrl,
      enabled: category.enabled,
    })
    .returning();

  if (includeProducts) {
    const prods = await db.select().from(products).where(eq(products.categoryId, category.id));
    for (const p of prods) {
      const productSlugBase = targetSiteId === p.siteId ? `${p.slug}-copy` : p.slug;
      await db.insert(products).values({
        siteId: targetSiteId,
        categoryId: copy.id,
        name: p.name,
        slug: await uniqueProductSlug(targetSiteId, productSlugBase),
        description: p.description,
        priceCents: p.priceCents,
        currency: p.currency,
        sku: null,
        stock: p.stock,
        images: p.images,
        enabled: p.enabled,
      });
    }
  }

  return NextResponse.json(await serializeCategoryDetail(copy), { status: 201 });
});
