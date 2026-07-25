import { ilike } from "drizzle-orm";
import { NextResponse } from "next/server";
import { dateRange, handler } from "@/lib/api";
import { db, sites } from "@/lib/db";
import { balanceStats, pendingCountsBySite } from "@/lib/queries";

export const GET = handler(async (req) => {
  const sp = new URL(req.url).searchParams;
  const { from, to } = dateRange(sp);
  const q = sp.get("q");

  const balances = await balanceStats({ from, to });
  const pending = await pendingCountsBySite();
  const siteRows = await db
    .select({ id: sites.id, name: sites.name, slug: sites.slug })
    .from(sites)
    .where(q ? ilike(sites.name, `%${q}%`) : undefined);

  return NextResponse.json({
    totalBalanceCents: balances.totalCents,
    x402BalanceCents: balances.x402Cents,
    fiatBalanceCents: balances.fiatCents,
    orderCount: balances.orderCount,
    sites: siteRows.map((s) => {
      const b = balances.bySite.get(s.id);
      return {
        siteId: s.id,
        siteName: s.name,
        siteSlug: s.slug,
        balanceCents: (b?.x402Cents ?? 0) + (b?.fiatCents ?? 0),
        x402Cents: b?.x402Cents ?? 0,
        fiatCents: b?.fiatCents ?? 0,
        orderCount: b?.orderCount ?? 0,
        pendingCount: pending.get(s.id) ?? 0,
      };
    }),
  });
});
