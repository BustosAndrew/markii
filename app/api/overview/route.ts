import { count } from "drizzle-orm";
import { NextResponse } from "next/server";
import { daysAgo, handler } from "@/lib/api";
import { db, sites } from "@/lib/db";
import { balanceStats, trafficStats } from "@/lib/queries";

export const GET = handler(async () => {
  const siteRows = await db
    .select({ status: sites.status, c: count() })
    .from(sites)
    .groupBy(sites.status);
  const siteCounts = { total: 0, live: 0, draft: 0, paused: 0 };
  for (const r of siteRows) {
    const n = Number(r.c);
    siteCounts.total += n;
    siteCounts[r.status] += n;
  }

  const traffic = await trafficStats({});
  const recent = await trafficStats({ from: daysAgo(14) });
  const balances = await balanceStats({});

  const allSites = await db
    .select({ id: sites.id, name: sites.name, slug: sites.slug })
    .from(sites);
  const bySite = allSites.map((s) => {
    const b = balances.bySite.get(s.id);
    return {
      siteId: s.id,
      siteName: s.name,
      siteSlug: s.slug,
      balanceCents: (b?.x402Cents ?? 0) + (b?.fiatCents ?? 0),
    };
  });

  return NextResponse.json({
    sites: siteCounts,
    traffic: {
      total: traffic.total,
      last7d: traffic.last7d,
      byDay: recent.byDay,
      topAgents: traffic.byAgent.slice(0, 5),
    },
    finances: {
      totalBalanceCents: balances.totalCents,
      x402BalanceCents: balances.x402Cents,
      fiatBalanceCents: balances.fiatCents,
      orderCount: balances.orderCount,
      bySite,
    },
  });
});
