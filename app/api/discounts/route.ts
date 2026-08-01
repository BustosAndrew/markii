import { and, count, desc, eq, ilike, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { boolParam, intParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { statusOf, usedCounts } from "@/lib/commerce/discounts";
import { db, discounts } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/discounts` (§18.5).
 *
 * Writes go through `discounts.create` / `update` / `delete` (§22 rule 1).
 *
 * `status` and `usedCount` are both **derived** — status from the enabled flag
 * and the date window, usage from the redemption table. A stored copy of either
 * drifts, and a usage limit enforced against a drifted counter either blocks
 * valid customers or lets a single-use code run forever.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);

    const conds: SQL[] = [siteScope(orgId, discounts.siteId)];
    const siteId = intParam(sp, "siteId");
    if (siteId != null) conds.push(eq(discounts.siteId, siteId));
    const q = sp.get("q");
    if (q) conds.push(or(ilike(discounts.code, `%${q}%`), ilike(discounts.title, `%${q}%`))!);
    const automatic = boolParam(sp, "automatic");
    if (automatic !== undefined) {
      conds.push(automatic ? isNull(discounts.code) : isNotNull(discounts.code));
    }

    const where = and(...conds);
    const [totalRow] = await db.select({ c: count() }).from(discounts).where(where);
    const rows = await db
      .select()
      .from(discounts)
      .where(where)
      .orderBy(desc(discounts.createdAt))
      .limit(limit)
      .offset(offset);

    const counts = await usedCounts(rows.map((r) => r.id));
    const now = new Date();

    const items = rows.map((d) => {
      const used = counts.get(d.id) ?? 0;
      return {
        ...d,
        status: statusOf(d, now),
        usedCount: used,
        /** Surfaced because a fully-redeemed code looks active until someone tries it. */
        exhausted: d.usageLimit != null && used >= d.usageLimit,
        startsAt: d.startsAt?.toISOString() ?? null,
        endsAt: d.endsAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      };
    });

    // Filter on the derived status rather than storing it.
    const status = sp.get("status");
    const filtered = status ? items.filter((i) => i.status === status) : items;

    return NextResponse.json({
      items: filtered,
      total: Number(totalRow?.c ?? 0),
      page,
      limit,
    });
  },
  { permission: "commerce.read" },
);
