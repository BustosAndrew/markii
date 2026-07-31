import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { intParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { levelsForVariants } from "@/lib/commerce/queries";
import { db, products, variants } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/inventory/levels` — filter by location, variant, or low stock (§18.1).
 *
 * Levels are summed from the ledger rather than read from a column, so this
 * always agrees with the entry history. If it ever disagrees, the ledger is
 * right and the reader is wrong.
 */
export const GET = orgHandler(async (req, { orgId }) => {
  const sp = new URL(req.url).searchParams;
  const { page, limit, offset } = pagination(sp);

  const conds: SQL[] = [siteScope(orgId, products.siteId)];
  const siteId = intParam(sp, "siteId");
  if (siteId != null) conds.push(eq(products.siteId, siteId));
  const productId = intParam(sp, "productId");
  if (productId != null) conds.push(eq(variants.productId, productId));

  const rows = await db
    .select({
      id: variants.id,
      productId: variants.productId,
      title: variants.title,
      sku: variants.sku,
      inventoryPolicy: variants.inventoryPolicy,
      productName: products.name,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(...conds))
    .orderBy(asc(variants.productId), asc(variants.position))
    .limit(limit)
    .offset(offset);

  const levels = await levelsForVariants(rows.map((r) => r.id));

  const locationFilter = intParam(sp, "locationId");
  const lowStock = intParam(sp, "lowStock");

  let items = rows.map((r) => {
    const all = levels.get(r.id) ?? [];
    const scoped = locationFilter != null ? all.filter((l) => l.locationId === locationFilter) : all;
    return {
      variantId: r.id,
      productId: r.productId,
      productName: r.productName,
      title: r.title,
      sku: r.sku,
      inventoryPolicy: r.inventoryPolicy,
      levels: scoped,
      totalAvailable: scoped.reduce((n, l) => n + l.available, 0),
      totalCommitted: scoped.reduce((n, l) => n + l.committed, 0),
    };
  });

  // Applied after summing, because "low stock" is a property of the total across
  // locations, not of any single ledger row.
  if (lowStock != null) items = items.filter((i) => i.totalAvailable <= lowStock);

  return NextResponse.json({ items, page, limit });
});
