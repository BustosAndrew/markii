import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, conflict, handler, pagination, slugify } from "@/lib/api";
import { db, sites } from "@/lib/db";
import { serializeSite, serializeSites } from "@/lib/queries";
import { siteCreateSchema } from "@/lib/validation";

export const GET = handler(async (req) => {
  const sp = new URL(req.url).searchParams;
  const { page, limit, offset } = pagination(sp);

  const conds: SQL[] = [];
  const q = sp.get("q");
  if (q) conds.push(or(ilike(sites.name, `%${q}%`), ilike(sites.slug, `%${q}%`))!);
  const status = sp.get("status");
  if (status) {
    if (!["draft", "live", "paused"].includes(status)) throw badRequest("invalid status filter");
    conds.push(eq(sites.status, status as "draft" | "live" | "paused"));
  }
  const where = conds.length ? and(...conds) : undefined;

  const sort = sp.get("sort") ?? "-createdAt";
  const orderBy =
    sort === "name"
      ? asc(sites.name)
      : sort === "createdAt"
        ? asc(sites.createdAt)
        : desc(sites.createdAt);

  const [totalRow] = await db.select({ c: count() }).from(sites).where(where);
  const rows = await db
    .select()
    .from(sites)
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  return NextResponse.json({
    items: await serializeSites(rows),
    total: Number(totalRow?.c ?? 0),
    page,
    limit,
  });
});

export const POST = handler(async (req) => {
  const input = siteCreateSchema.parse(await req.json());
  const slug = input.slug ?? slugify(input.name);
  const [existing] = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).limit(1);
  if (existing) throw conflict(`site slug "${slug}" is already taken`);
  const [row] = await db
    .insert(sites)
    .values({ ...input, slug })
    .returning();
  return NextResponse.json(await serializeSite(row), { status: 201 });
});
