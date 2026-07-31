import { and, asc, count, desc, eq, gt, ilike, or, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { boolParam, conflict, intParam, notFound, pagination, slugify } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { ownSites, siteScope, siteScopeForStaff } from "@/lib/tenancy";
import { categories, db, products, sites } from "@/lib/db";
import { serializeProductDetail, serializeProducts } from "@/lib/queries";
import { productCreateSchema } from "@/lib/validation";

export const GET = orgHandler(async (req, { session, orgId }) => {
  const sp = new URL(req.url).searchParams;
  const { page, limit, offset } = pagination(sp);

  // Org scope first and unconditional; every filter below narrows it.
  const conds: SQL[] = [siteScopeForStaff(orgId, session.staff.storeIds, products.siteId)];
  const q = sp.get("q");
  if (q)
    conds.push(
      or(
        ilike(products.name, `%${q}%`),
        ilike(products.slug, `%${q}%`),
        ilike(products.sku, `%${q}%`),
      )!,
    );
  const siteId = intParam(sp, "siteId");
  if (siteId != null) conds.push(eq(products.siteId, siteId));
  const categoryId = intParam(sp, "categoryId");
  if (categoryId != null) conds.push(eq(products.categoryId, categoryId));
  const enabled = boolParam(sp, "enabled");
  if (enabled !== undefined) conds.push(eq(products.enabled, enabled));
  if (boolParam(sp, "inStock") === true) conds.push(gt(products.stock, 0));
  const where = and(...conds);

  const sortMap: Record<string, SQL | ReturnType<typeof asc>> = {
    name: asc(products.name),
    priceCents: asc(products.priceCents),
    "-priceCents": desc(products.priceCents),
    createdAt: asc(products.createdAt),
    "-createdAt": desc(products.createdAt),
  };
  const orderBy = sortMap[sp.get("sort") ?? "-createdAt"] ?? desc(products.createdAt);

  const [totalRow] = await db.select({ c: count() }).from(products).where(where);
  const rows = await db
    .select()
    .from(products)
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  return NextResponse.json({
    items: await serializeProducts(rows),
    total: Number(totalRow?.c ?? 0),
    page,
    limit,
  });
});

export const POST = orgHandler(async (req, { orgId }) => {
  const input = productCreateSchema.parse(await req.json());

  const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, input.siteId), ownSites(orgId))).limit(1);
  if (!site) throw notFound("Site");

  if (input.categoryId != null) {
    const [cat] = await db
      .select({ id: categories.id, siteId: categories.siteId })
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), siteScope(orgId, categories.siteId)))
      .limit(1);
    if (!cat) throw notFound("Category");
    if (cat.siteId !== input.siteId) throw conflict("category belongs to a different site");
  }

  const slug = input.slug ?? slugify(input.name);
  const [taken] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.siteId, input.siteId), eq(products.slug, slug)))
    .limit(1);
  if (taken) throw conflict(`product slug "${slug}" already exists on this site`);

  const [row] = await db
    .insert(products)
    .values({ ...input, slug })
    .returning();
  return NextResponse.json(await serializeProductDetail(row), { status: 201 });
});
