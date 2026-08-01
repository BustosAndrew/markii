import { and, asc, count, eq, ilike, isNotNull, isNull, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { boolParam, intParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { countMembers } from "@/lib/commerce/collection-queries";
import { collections, db } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/collections` (§18.2).
 *
 * Creation goes through `catalog.createCollection` — every mutation runs through
 * the action registry (§22 rule 1).
 */
export const GET = orgHandler(async (req, { orgId }) => {
  const sp = new URL(req.url).searchParams;
  const { page, limit, offset } = pagination(sp);

  const conds: SQL[] = [siteScope(orgId, collections.siteId)];
  const siteId = intParam(sp, "siteId");
  if (siteId != null) conds.push(eq(collections.siteId, siteId));
  const q = sp.get("q");
  if (q) conds.push(ilike(collections.title, `%${q}%`));
  const published = boolParam(sp, "published");
  if (published !== undefined) {
    conds.push(published ? isNotNull(collections.publishedAt) : isNull(collections.publishedAt));
  }

  const where = and(...conds);
  const [totalRow] = await db.select({ c: count() }).from(collections).where(where);
  const rows = await db
    .select()
    .from(collections)
    .where(where)
    .orderBy(asc(collections.id))
    .limit(limit)
    .offset(offset);

  const counts = await countMembers(rows);

  return NextResponse.json({
    items: rows.map((c) => ({
      ...c,
      productCount: counts.get(c.id) ?? 0,
      publishedAt: c.publishedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    total: Number(totalRow?.c ?? 0),
    page,
    limit,
  });
});
