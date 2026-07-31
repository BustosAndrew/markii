import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  inventoryLedger,
  locations,
  productOptions,
  products,
  sites,
  variants,
  type Variant,
} from "../db";
import { ownSites, siteScope, type OrgId } from "../tenancy";

/**
 * Read helpers for variants and inventory (§18.1).
 *
 * Like `lib/queries.ts`, every export takes `orgId` as a **required** argument.
 * There is no unscoped variant to reach for by mistake.
 */

/**
 * Inventory levels for a set of variants, derived by summing the ledger.
 *
 * Levels are **not** stored. A running total you overwrite cannot be reconciled
 * against a physical count and cannot be undone, which is the whole reason
 * §18.1 specifies an append-only ledger.
 */
export async function levelsForVariants(variantIds: number[]) {
  if (variantIds.length === 0) return new Map<number, { locationId: number; available: number; committed: number }[]>();

  const rows = await db
    .select({
      variantId: inventoryLedger.variantId,
      locationId: inventoryLedger.locationId,
      available: sql<string>`coalesce(sum(${inventoryLedger.availableDelta}), 0)`,
      committed: sql<string>`coalesce(sum(${inventoryLedger.committedDelta}), 0)`,
    })
    .from(inventoryLedger)
    .where(inArray(inventoryLedger.variantId, variantIds))
    .groupBy(inventoryLedger.variantId, inventoryLedger.locationId);

  const map = new Map<number, { locationId: number; available: number; committed: number }[]>();
  for (const r of rows) {
    const entry = { locationId: r.locationId, available: Number(r.available), committed: Number(r.committed) };
    map.set(r.variantId, [...(map.get(r.variantId) ?? []), entry]);
  }
  return map;
}

export async function serializeVariants(list: Variant[]) {
  const levels = await levelsForVariants(list.map((v) => v.id));
  return list.map((v) => ({
    ...v,
    inventoryLevels: levels.get(v.id) ?? [],
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  }));
}

/** A product's variants and option axes, org-scoped through the product's site. */
export async function variantsForProduct(orgId: OrgId, productId: number) {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), siteScope(orgId, products.siteId)))
    .limit(1);
  if (!product) return null;

  const options = await db
    .select()
    .from(productOptions)
    .where(eq(productOptions.productId, productId))
    .orderBy(asc(productOptions.position));

  const rows = await db
    .select()
    .from(variants)
    .where(eq(variants.productId, productId))
    .orderBy(asc(variants.position));

  return {
    productId,
    options: options.map((o) => ({ name: o.name, position: o.position, values: o.values })),
    variants: await serializeVariants(rows),
  };
}

/** Locations belonging to the org, optionally narrowed to one store. */
export async function locationsForOrg(orgId: OrgId, siteId?: number) {
  const conds = [ownSites(orgId)];
  if (siteId != null) conds.push(eq(locations.siteId, siteId));
  return db
    .select({
      id: locations.id,
      siteId: locations.siteId,
      name: locations.name,
      isDefault: locations.isDefault,
    })
    .from(locations)
    // Locations carry no orgId of their own; they reach it through their site,
    // which is the single tenancy root (§16).
    .innerJoin(sites, eq(sites.id, locations.siteId))
    .where(and(...conds))
    .orderBy(asc(locations.id));
}
