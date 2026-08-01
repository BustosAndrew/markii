import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  collectionProducts,
  collections,
  db,
  products,
  type Collection,
} from "../db";
import { siteScope, type OrgId } from "../tenancy";
import { collectionOrderBy, rulesToCondition } from "./collections";

/**
 * Membership resolution for collections (§18.2).
 *
 * Manual collections read their join table; automated ones evaluate their rules
 * against the catalog at read time. Rule results are **not** materialised — a
 * cached membership goes stale the moment a product's price or stock changes,
 * and a "Under £20" collection showing a £30 item is worse than a slower query.
 */

/** Products in a collection, honouring its type and sort order. */
export async function membersOf(collection: Collection, limit = 100, offset = 0) {
  if (collection.type === "manual") {
    const rows = await db
      .select({ product: products, position: collectionProducts.position })
      .from(collectionProducts)
      .innerJoin(products, eq(products.id, collectionProducts.productId))
      .where(eq(collectionProducts.collectionId, collection.id))
      .orderBy(asc(collectionProducts.position))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => r.product);
  }

  const { condition } = rulesToCondition(collection.rules, collection.rulesMatch);
  // No usable rules means an empty collection, never the whole catalog. Widening
  // is the dangerous direction to fail in.
  if (!condition) return [];

  return db
    .select()
    .from(products)
    .where(and(eq(products.siteId, collection.siteId), condition))
    .orderBy(collectionOrderBy(collection.sortOrder))
    .limit(limit)
    .offset(offset);
}

/** Member counts for a page of collections, in as few queries as the two types allow. */
export async function countMembers(list: Collection[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  const manual = list.filter((c) => c.type === "manual");
  const automated = list.filter((c) => c.type === "automated");

  if (manual.length > 0) {
    const rows = await db
      .select({ collectionId: collectionProducts.collectionId, c: count() })
      .from(collectionProducts)
      .where(inArray(collectionProducts.collectionId, manual.map((c) => c.id)))
      .groupBy(collectionProducts.collectionId);
    for (const r of rows) counts.set(r.collectionId, Number(r.c));
  }

  // Automated collections each need their own count: the rules differ per row,
  // so there is no single grouped query that answers all of them.
  for (const c of automated) {
    const { condition } = rulesToCondition(c.rules, c.rulesMatch);
    if (!condition) {
      counts.set(c.id, 0);
      continue;
    }
    const [row] = await db
      .select({ c: count() })
      .from(products)
      .where(and(eq(products.siteId, c.siteId), condition));
    counts.set(c.id, Number(row?.c ?? 0));
  }

  for (const c of list) if (!counts.has(c.id)) counts.set(c.id, 0);
  return counts;
}

/** Resolve by numeric id or handle, org-scoped. `handle` needs `siteId` to disambiguate. */
export async function resolveCollection(
  idOrHandle: string,
  orgId: OrgId,
  siteId?: number,
): Promise<Collection | null> {
  const isNumeric = /^\d+$/.test(idOrHandle);
  const base = isNumeric
    ? eq(collections.id, Number(idOrHandle))
    : siteId != null
      ? and(eq(collections.handle, idOrHandle), eq(collections.siteId, siteId))!
      : eq(collections.handle, idOrHandle);

  const [row] = await db
    .select()
    .from(collections)
    .where(and(base, siteScope(orgId, collections.siteId)))
    .limit(1);
  return row ?? null;
}
