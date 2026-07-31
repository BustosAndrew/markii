import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, conflict, pagination, slugify } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites } from "@/lib/db";
import { invalidateCustomDomain } from "@/lib/domains";
import { serializeSite, serializeSites } from "@/lib/queries";
import { ownSitesForStaff } from "@/lib/tenancy";
import { siteCreateSchema } from "@/lib/validation";

export const GET = orgHandler(async (req, { session, orgId }) => {
  const sp = new URL(req.url).searchParams;
  const { page, limit, offset } = pagination(sp);

  // Org scope first, and unconditionally — every other filter narrows it further.
  const conds: SQL[] = [ownSitesForStaff(orgId, session.storeIds)];
  const q = sp.get("q");
  if (q) conds.push(or(ilike(sites.name, `%${q}%`), ilike(sites.slug, `%${q}%`))!);
  const status = sp.get("status");
  if (status) {
    if (!["draft", "live", "paused"].includes(status)) throw badRequest("invalid status filter");
    conds.push(eq(sites.status, status as "draft" | "live" | "paused"));
  }
  const where = and(...conds);

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

export const POST = orgHandler(
  async (req, { orgId }) => {
    const input = siteCreateSchema.parse(await req.json());
    const slug = input.slug ?? slugify(input.name);
    // Site slugs are globally unique (they are subdomains), so this check stays
    // deliberately unscoped — another org holding the slug is still a conflict.
    const [existing] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.slug, slug))
      .limit(1);
    if (existing) throw conflict(`site slug "${slug}" is already taken`);
    const [row] = await db
      .insert(sites)
      // orgId comes from the session, never the request body (§16).
      .values({ ...input, slug, orgId })
      .returning();
    // Clears any negative entry cached while the host was still unconnected.
    invalidateCustomDomain(row.customDomain);
    return NextResponse.json(await serializeSite(row), { status: 201 });
  },
  { permission: "cms.write" },
);
