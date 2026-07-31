import { and, count, eq, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { dateRange, daysAgo, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { agentTraffic, db, products } from "@/lib/db";
import { resolveSite, siteRef, trafficStats } from "@/lib/queries";

export const GET = orgHandler(async (req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug, orgId);
  const sp = new URL(req.url).searchParams;
  const range = dateRange(sp);
  const from = range.from ?? daysAgo(28);
  const to = range.to;
  const q = sp.get("q")?.toLowerCase();
  const { page, limit } = pagination(sp);

  const stats = await trafficStats({ orgId, siteId: site.id, from, to });

  const conds: SQL[] = [
    eq(agentTraffic.siteId, site.id),
    isNotNull(agentTraffic.productId),
    gte(agentTraffic.createdAt, from),
  ];
  if (to) conds.push(lte(agentTraffic.createdAt, to));

  const viewRows = await db
    .select({ productId: agentTraffic.productId, c: count() })
    .from(agentTraffic)
    .where(and(...conds))
    .groupBy(agentTraffic.productId)
    .orderBy(sql`2 desc`);
  const agentRows = await db
    .select({
      productId: agentTraffic.productId,
      agentName: agentTraffic.agentName,
      c: count(),
    })
    .from(agentTraffic)
    .where(and(...conds))
    .groupBy(agentTraffic.productId, agentTraffic.agentName);

  const productIds = viewRows.map((r) => r.productId).filter((id): id is number => id != null);
  const prodMap = new Map(
    productIds.length
      ? (
          await db
            .select({ id: products.id, name: products.name, slug: products.slug })
            .from(products)
            .where(sql`${products.id} in ${productIds}`)
        ).map((p) => [p.id, p])
      : [],
  );
  const agentsByProduct = new Map<number, { agentName: string; views: number }[]>();
  for (const r of agentRows) {
    if (r.productId == null) continue;
    agentsByProduct.set(r.productId, [
      ...(agentsByProduct.get(r.productId) ?? []),
      { agentName: r.agentName, views: Number(r.c) },
    ]);
  }

  let items = viewRows
    .filter((r): r is typeof r & { productId: number } => r.productId != null)
    .map((r) => {
      const p = prodMap.get(r.productId);
      return {
        productId: r.productId,
        name: p?.name ?? `(deleted product ${r.productId})`,
        slug: p?.slug ?? null,
        views: Number(r.c),
        agents: (agentsByProduct.get(r.productId) ?? []).sort((a, b) => b.views - a.views),
      };
    });
  if (q) items = items.filter((i) => i.name.toLowerCase().includes(q));
  const total = items.length;
  items = items.slice((page - 1) * limit, page * limit);

  return NextResponse.json({
    site: siteRef(site),
    total: stats.total,
    byDay: stats.byDay,
    byAgent: stats.byAgent,
    products: { items, total, page, limit },
  });
});
