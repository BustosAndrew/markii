import { and, count, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, boolParam, conflict, intParam, notFound, pagination, slugify } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { ownSites, siteScope, siteScopeForStaff } from "@/lib/tenancy";
import { categories, db, sites } from "@/lib/db";
import { serializeCategories, serializeCategoryDetail } from "@/lib/queries";
import { categoryCreateSchema } from "@/lib/validation";

export const GET = orgHandler(async (req, { session, orgId }) => {
  const sp = new URL(req.url).searchParams;
  const { page, limit, offset } = pagination(sp);

  const conds: SQL[] = [siteScopeForStaff(orgId, session.storeIds, categories.siteId)];
  const q = sp.get("q");
  if (q) conds.push(or(ilike(categories.name, `%${q}%`), ilike(categories.slug, `%${q}%`))!);
  const siteId = intParam(sp, "siteId");
  if (siteId != null) conds.push(eq(categories.siteId, siteId));
  const parentParam = sp.get("parentId");
  if (parentParam === "null") conds.push(isNull(categories.parentId));
  else if (parentParam != null) {
    const parentId = parseInt(parentParam, 10);
    if (!Number.isFinite(parentId)) throw badRequest("parentId must be a number or 'null'");
    conds.push(eq(categories.parentId, parentId));
  }
  const enabled = boolParam(sp, "enabled");
  if (enabled !== undefined) conds.push(eq(categories.enabled, enabled));
  const where = and(...conds);

  const [totalRow] = await db.select({ c: count() }).from(categories).where(where);
  const rows = await db
    .select()
    .from(categories)
    .where(where)
    .orderBy(desc(categories.createdAt))
    .limit(limit)
    .offset(offset);

  return NextResponse.json({
    items: await serializeCategories(rows),
    total: Number(totalRow?.c ?? 0),
    page,
    limit,
  });
});

export const POST = orgHandler(async (req, { orgId }) => {
  const input = categoryCreateSchema.parse(await req.json());

  const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, input.siteId), ownSites(orgId))).limit(1);
  if (!site) throw notFound("Site");

  if (input.parentId != null) {
    const [parent] = await db
      .select({ id: categories.id, siteId: categories.siteId })
      .from(categories)
      .where(eq(categories.id, input.parentId))
      .limit(1);
    if (!parent) throw notFound("Parent category");
    if (parent.siteId !== input.siteId)
      throw badRequest("parent category belongs to a different site");
  }

  const slug = input.slug ?? slugify(input.name);
  const [taken] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.siteId, input.siteId), eq(categories.slug, slug)))
    .limit(1);
  if (taken) throw conflict(`category slug "${slug}" already exists on this site`);

  const [row] = await db
    .insert(categories)
    .values({ ...input, slug })
    .returning();
  return NextResponse.json(await serializeCategoryDetail(row), { status: 201 });
});
