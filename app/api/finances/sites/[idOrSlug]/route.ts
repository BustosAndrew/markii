import { count, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, orders, products } from "@/lib/db";
import {
  balanceStats,
  resolveSite,
  serializeOrders,
  siteRef,
  transactionFilters,
} from "@/lib/queries";

export const GET = orgHandler(async (req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug, orgId);
  const sp = new URL(req.url).searchParams;
  const { page, limit, offset } = pagination(sp);

  const where = transactionFilters(site.id, sp);
  const [totalRow] = await db
    .select({ c: count() })
    .from(orders)
    .leftJoin(products, eq(orders.productId, products.id))
    .where(where);
  const rows = await db
    .select({ order: orders })
    .from(orders)
    .leftJoin(products, eq(orders.productId, products.id))
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(limit)
    .offset(offset);

  const balances = await balanceStats({ orgId, siteId: site.id });

  return NextResponse.json({
    site: siteRef(site),
    balance: {
      totalCents: balances.totalCents,
      x402Cents: balances.x402Cents,
      fiatCents: balances.fiatCents,
    },
    transactions: {
      items: await serializeOrders(rows.map((r) => r.order)),
      total: Number(totalRow?.c ?? 0),
      page,
      limit,
    },
  });
});
