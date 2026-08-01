import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { boolParam, intParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { customers, db, orders } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/customers` (§18.3). Creation goes through `customers.create`.
 *
 * `ordersCount` and `totalSpentMinor` are computed here rather than stored: a
 * denormalised total drifts after the first refund, and a customer list that
 * disagrees with the orders list is worse than one extra query.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);

    const conds: SQL[] = [siteScope(orgId, customers.siteId)];
    const siteId = intParam(sp, "siteId");
    if (siteId != null) conds.push(eq(customers.siteId, siteId));
    const q = sp.get("q");
    if (q) {
      conds.push(
        or(
          ilike(customers.email, `%${q}%`),
          ilike(customers.firstName, `%${q}%`),
          ilike(customers.lastName, `%${q}%`),
        )!,
      );
    }
    const marketing = boolParam(sp, "acceptsMarketing");
    if (marketing !== undefined) conds.push(eq(customers.acceptsMarketing, marketing));

    const where = and(...conds);
    const [totalRow] = await db.select({ c: count() }).from(customers).where(where);
    const rows = await db
      .select()
      .from(customers)
      .where(where)
      .orderBy(desc(customers.createdAt))
      .limit(limit)
      .offset(offset);

    // Only successful orders count toward spend — pending and failed are not money.
    const stats = new Map<number, { ordersCount: number; totalSpentMinor: number }>();
    if (rows.length > 0) {
      const agg = await db
        .select({
          customerId: orders.customerId,
          c: count(),
          total: sql<string>`coalesce(sum(${orders.amountCents}), 0)`,
        })
        .from(orders)
        .where(
          and(
            inArray(orders.customerId, rows.map((r) => r.id)),
            eq(orders.status, "success"),
          ),
        )
        .groupBy(orders.customerId);
      for (const a of agg) {
        if (a.customerId != null) {
          stats.set(a.customerId, { ordersCount: Number(a.c), totalSpentMinor: Number(a.total) });
        }
      }
    }

    return NextResponse.json({
      items: rows.map((c) => ({
        ...c,
        ordersCount: stats.get(c.id)?.ordersCount ?? 0,
        totalSpentMinor: stats.get(c.id)?.totalSpentMinor ?? 0,
        marketingConsentAt: c.marketingConsentAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      total: Number(totalRow?.c ?? 0),
      page,
      limit,
    });
  },
  { permission: "commerce.read" },
);
