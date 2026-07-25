import { and, count, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { daysAgo, handler } from "@/lib/api";
import { db, orders } from "@/lib/db";
import { balanceStats, resolveSite, trafficStats } from "@/lib/queries";

export const GET = handler(async (_req, { params }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug);

  const traffic = await trafficStats({ siteId: site.id });
  const balances = await balanceStats({ siteId: site.id });
  const [purchasesTotal] = await db
    .select({ c: count() })
    .from(orders)
    .where(and(eq(orders.siteId, site.id), eq(orders.status, "success")));
  const [purchases7d] = await db
    .select({ c: count() })
    .from(orders)
    .where(
      and(
        eq(orders.siteId, site.id),
        eq(orders.status, "success"),
        gte(orders.createdAt, daysAgo(7)),
      ),
    );

  return NextResponse.json({
    traffic: { total: traffic.total, last7d: traffic.last7d, byDay: traffic.byDay },
    purchases: {
      count: Number(purchasesTotal?.c ?? 0),
      last7d: Number(purchases7d?.c ?? 0),
    },
    balance: {
      totalCents: balances.totalCents,
      x402Cents: balances.x402Cents,
      fiatCents: balances.fiatCents,
    },
  });
});
