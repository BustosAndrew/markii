import { and, count, gte, ilike, lte, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { dateRange, daysAgo } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { ownSites, siteScope } from "@/lib/tenancy";
import { agentTraffic, db, sites } from "@/lib/db";
import { trafficStats } from "@/lib/queries";

export const GET = orgHandler(async (req, { orgId }) => {
  const sp = new URL(req.url).searchParams;
  const range = dateRange(sp);
  const from = range.from ?? daysAgo(28);
  const to = range.to;
  const q = sp.get("q");

  const global = await trafficStats({ orgId, from, to });

  const rangeConds: SQL[] = [siteScope(orgId, agentTraffic.siteId), gte(agentTraffic.createdAt, from)];
  if (to) rangeConds.push(lte(agentTraffic.createdAt, to));

  const totals = await db
    .select({ siteId: agentTraffic.siteId, c: count() })
    .from(agentTraffic)
    .where(and(...rangeConds))
    .groupBy(agentTraffic.siteId);
  const totals7d = await db
    .select({ siteId: agentTraffic.siteId, c: count() })
    .from(agentTraffic)
    .where(gte(agentTraffic.createdAt, daysAgo(7)))
    .groupBy(agentTraffic.siteId);
  const agents = await db
    .select({ siteId: agentTraffic.siteId, agentName: agentTraffic.agentName, c: count() })
    .from(agentTraffic)
    .where(and(...rangeConds))
    .groupBy(agentTraffic.siteId, agentTraffic.agentName);

  const totalBySite = new Map(totals.map((r) => [r.siteId, Number(r.c)]));
  const total7dBySite = new Map(totals7d.map((r) => [r.siteId, Number(r.c)]));
  const topAgentBySite = new Map<number, { name: string; count: number }>();
  for (const r of agents) {
    const current = topAgentBySite.get(r.siteId);
    if (!current || Number(r.c) > current.count)
      topAgentBySite.set(r.siteId, { name: r.agentName, count: Number(r.c) });
  }

  const siteRows = await db
    .select({ id: sites.id, name: sites.name, slug: sites.slug })
    .from(sites)
    .where(q ? and(ownSites(orgId), ilike(sites.name, `%${q}%`)) : ownSites(orgId));

  return NextResponse.json({
    total: global.total,
    byDay: global.byDay,
    byAgent: global.byAgent,
    sites: siteRows.map((s) => ({
      siteId: s.id,
      siteName: s.name,
      siteSlug: s.slug,
      total: totalBySite.get(s.id) ?? 0,
      last7d: total7dBySite.get(s.id) ?? 0,
      topAgent: topAgentBySite.get(s.id)?.name ?? null,
    })),
  });
});
