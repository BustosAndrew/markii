import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { handler, slugify } from "@/lib/api";
import { categories, db, products, sites, type Category, type Product } from "@/lib/db";
import { serializeCategories, serializeProducts, uniqueCategorySlug } from "@/lib/queries";
import { importCommitSchema } from "@/lib/validation";

/**
 * Phase 2 of the CSV/scrape popup: the user has allocated staged items to sites
 * (and optionally categories). The same tempId may appear in several allocations —
 * that's the drag-to-duplicate behavior.
 */
export const POST = handler(async (req) => {
  const input = importCommitSchema.parse(await req.json());

  const itemByTempId = new Map(input.items.map((i) => [i.tempId, i]));
  const categoryByTempId = new Map(input.categories.map((c) => [c.tempId, c]));
  const siteExists = new Map<number, boolean>();
  const ensureSite = async (siteId: number): Promise<boolean> => {
    if (!siteExists.has(siteId)) {
      const [s] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId)).limit(1);
      siteExists.set(siteId, !!s);
    }
    return siteExists.get(siteId)!;
  };

  const createdCategories: Category[] = [];
  const createdProducts: Product[] = [];
  const failed: { tempId: string; reason: string }[] = [];
  // staged category tempId + target site → created category id
  const createdCategoryIds = new Map<string, number>();

  // categories first so products can land inside them
  for (const alloc of input.allocations.filter((a) => categoryByTempId.has(a.tempId))) {
    const staged = categoryByTempId.get(alloc.tempId)!;
    if (!(await ensureSite(alloc.siteId))) {
      failed.push({ tempId: alloc.tempId, reason: `site ${alloc.siteId} does not exist` });
      continue;
    }
    if (alloc.parentCategoryId != null) {
      const [parent] = await db
        .select({ id: categories.id, siteId: categories.siteId })
        .from(categories)
        .where(eq(categories.id, alloc.parentCategoryId))
        .limit(1);
      if (!parent || parent.siteId !== alloc.siteId) {
        failed.push({
          tempId: alloc.tempId,
          reason: `parent category ${alloc.parentCategoryId} not found on site ${alloc.siteId}`,
        });
        continue;
      }
    }
    const slug = await uniqueCategorySlug(alloc.siteId, slugify(staged.name));
    const [row] = await db
      .insert(categories)
      .values({
        siteId: alloc.siteId,
        parentId: alloc.parentCategoryId ?? null,
        name: staged.name,
        slug,
      })
      .returning();
    createdCategories.push(row);
    createdCategoryIds.set(`${alloc.tempId}:${alloc.siteId}`, row.id);
  }

  for (const alloc of input.allocations.filter((a) => itemByTempId.has(a.tempId))) {
    const item = itemByTempId.get(alloc.tempId)!;
    if (!(await ensureSite(alloc.siteId))) {
      failed.push({ tempId: alloc.tempId, reason: `site ${alloc.siteId} does not exist` });
      continue;
    }

    let categoryId: number | null = null;
    if (alloc.categoryId != null) {
      const [cat] = await db
        .select({ id: categories.id, siteId: categories.siteId })
        .from(categories)
        .where(eq(categories.id, alloc.categoryId))
        .limit(1);
      if (!cat || cat.siteId !== alloc.siteId) {
        failed.push({
          tempId: alloc.tempId,
          reason: `category ${alloc.categoryId} not found on site ${alloc.siteId}`,
        });
        continue;
      }
      categoryId = cat.id;
    } else if (alloc.categoryTempId) {
      categoryId = createdCategoryIds.get(`${alloc.categoryTempId}:${alloc.siteId}`) ?? null;
      if (categoryId == null) {
        failed.push({
          tempId: alloc.tempId,
          reason: `staged category "${alloc.categoryTempId}" was not allocated to site ${alloc.siteId}`,
        });
        continue;
      }
    }

    const slug = item.slug ?? slugify(item.name);
    const [taken] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.siteId, alloc.siteId), eq(products.slug, slug)))
      .limit(1);
    if (taken) {
      failed.push({ tempId: alloc.tempId, reason: `duplicate slug "${slug}" on site ${alloc.siteId}` });
      continue;
    }

    const [row] = await db
      .insert(products)
      .values({
        siteId: alloc.siteId,
        categoryId,
        name: item.name,
        slug,
        description: item.description ?? null,
        priceCents: item.priceCents,
        currency: item.currency,
        sku: item.sku ?? null,
        stock: item.stock,
        images: item.images,
      })
      .returning();
    createdProducts.push(row);
  }

  return NextResponse.json(
    {
      createdProducts: await serializeProducts(createdProducts),
      createdCategories: await serializeCategories(createdCategories),
      failed,
    },
    { status: 201 },
  );
});
