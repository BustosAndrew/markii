import { and, eq, inArray, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, conflict, handler, intParam, notFound } from "@/lib/api";
import { categories, db, products, sites, type Category } from "@/lib/db";
import {
  resolveCategory,
  serializeCategoryDetail,
  uniqueCategorySlug,
  uniqueProductSlug,
} from "@/lib/queries";
import { categoryUpdateSchema } from "@/lib/validation";

/** The category plus all its descendants (site-scoped tree walk). */
async function subtree(category: Category): Promise<Category[]> {
  const all = await db.select().from(categories).where(eq(categories.siteId, category.siteId));
  const byParent = new Map<number, Category[]>();
  for (const c of all) {
    if (c.parentId != null) {
      byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
    }
  }
  const result: Category[] = [];
  const queue = [category];
  while (queue.length) {
    const cur = queue.shift()!;
    result.push(cur);
    queue.push(...(byParent.get(cur.id) ?? []));
  }
  return result;
}

export const GET = handler(async (req, { params }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const category = await resolveCategory(idOrSlug, intParam(sp, "siteId"));
  return NextResponse.json(await serializeCategoryDetail(category));
});

export const PATCH = handler(async (req, { params }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const category = await resolveCategory(idOrSlug, intParam(sp, "siteId"));
  const input = categoryUpdateSchema.parse(await req.json());

  const targetSiteId = input.siteId ?? category.siteId;
  if (input.siteId != null && input.siteId !== category.siteId) {
    const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, input.siteId)).limit(1);
    if (!site) throw notFound("Target site");
  }

  // parent validation: must exist, same site, and not create a cycle
  if (input.parentId != null) {
    if (input.parentId === category.id) throw badRequest("a category cannot be its own parent");
    const [parent] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, input.parentId))
      .limit(1);
    if (!parent) throw notFound("Parent category");
    if (parent.siteId !== targetSiteId)
      throw badRequest("parent category belongs to a different site");
    const descendants = await subtree(category);
    if (descendants.some((d) => d.id === input.parentId))
      throw badRequest("cannot move a category under one of its own subcategories");
  }

  // slug uniqueness on (possibly new) site
  if (input.slug && input.slug !== category.slug) {
    const [taken] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.siteId, targetSiteId),
          eq(categories.slug, input.slug),
          ne(categories.id, category.id),
        ),
      )
      .limit(1);
    if (taken) throw conflict(`category slug "${input.slug}" already exists on this site`);
  }

  // cross-site move: bring the whole subtree and its products along
  if (targetSiteId !== category.siteId) {
    const moved = await subtree(category);
    const movedIds = moved.map((c) => c.id);
    for (const c of moved) {
      const slug = await uniqueCategorySlug(targetSiteId, c.slug);
      await db
        .update(categories)
        .set({ siteId: targetSiteId, slug, updatedAt: new Date() })
        .where(eq(categories.id, c.id));
    }
    const movedProducts = await db
      .select()
      .from(products)
      .where(inArray(products.categoryId, movedIds));
    for (const p of movedProducts) {
      const slug = await uniqueProductSlug(targetSiteId, p.slug);
      await db
        .update(products)
        .set({ siteId: targetSiteId, slug, updatedAt: new Date() })
        .where(eq(products.id, p.id));
    }
    // moving cross-site detaches from the old parent unless a new one was given
    if (input.parentId === undefined && category.parentId != null) input.parentId = null;
  }

  const [row] = await db
    .update(categories)
    .set({ ...input, siteId: targetSiteId, updatedAt: new Date() })
    .where(eq(categories.id, category.id))
    .returning();
  return NextResponse.json(await serializeCategoryDetail(row));
});

export const DELETE = handler(async (req, { params }) => {
  const { idOrSlug } = await params;
  const sp = new URL(req.url).searchParams;
  const category = await resolveCategory(idOrSlug, intParam(sp, "siteId"));
  // FK rules: products.categoryId → null, children.parentId → null (promoted)
  await db.delete(categories).where(eq(categories.id, category.id));
  return NextResponse.json({ deleted: true, id: category.id });
});
