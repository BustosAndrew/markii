import "server-only";

import { and, asc, count, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  categories,
  collectionProducts,
  collections,
  db,
  inventoryLedger,
  locations,
  products,
  sites,
  variants,
} from "../../db";
import { notFound } from "../../api";
import { computeReadiness } from "../../readiness/compute";
import { ownSitesForStaff, siteScopeForStaff } from "../../tenancy";

/**
 * The catalog agent's reads (D47).
 *
 * **Scoped to the person, not just the org.** A staff member limited to two
 * stores (`staff.storeIds`) gets an agent limited to the same two — the agent
 * reads with the asker's reach, never more. Every query here takes the scope
 * and applies it; there is no unscoped variant to reach for.
 *
 * Direct queries rather than the REST handlers the MCP read tools forward to:
 * those handlers serve dashboard screens and return whole rows, and every
 * field the model reads is paid for on every turn it stays in context. These
 * return the compact shapes an agent needs and nothing else.
 */

export type ReadScope = { orgId: string; storeIds: number[] | "all" };

/** Longest text field returned whole. A full description is one `get_product` away. */
const LIST_TEXT_CHARS = 160;
const DETAIL_TEXT_CHARS = 4_000;

function clip(text: string | null, max: number): string | null {
  if (text == null) return null;
  return text.length > max ? `${text.slice(0, max)}… (${text.length} characters)` : text;
}

function productScope(scope: ReadScope): SQL {
  return siteScopeForStaff(scope.orgId, scope.storeIds, products.siteId);
}

export async function listStores(scope: ReadScope) {
  return db
    .select({ id: sites.id, name: sites.name, slug: sites.slug, status: sites.status })
    .from(sites)
    .where(ownSitesForStaff(scope.orgId, scope.storeIds))
    .orderBy(asc(sites.id));
}

export type ProductSearch = {
  siteId?: number;
  query?: string;
  enabled?: boolean;
  missing?: "description" | "images" | "sku" | "category";
  limit: number;
  offset: number;
};

export async function searchProducts(scope: ReadScope, q: ProductSearch) {
  const conds: SQL[] = [productScope(scope)];
  if (q.siteId != null) conds.push(eq(products.siteId, q.siteId));
  if (q.enabled != null) conds.push(eq(products.enabled, q.enabled));
  if (q.query?.trim()) {
    const like = `%${q.query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(products.name, like), ilike(products.sku, like))!);
  }
  if (q.missing === "description") {
    conds.push(or(isNull(products.description), sql`btrim(${products.description}) = ''`)!);
  } else if (q.missing === "images") {
    conds.push(sql`jsonb_array_length(${products.images}) = 0`);
  } else if (q.missing === "sku") {
    conds.push(or(isNull(products.sku), sql`btrim(${products.sku}) = ''`)!);
  } else if (q.missing === "category") {
    conds.push(isNull(products.categoryId));
  }
  const where = and(...conds);

  const [total] = await db.select({ c: count() }).from(products).where(where);
  const rows = await db
    .select()
    .from(products)
    .where(where)
    .orderBy(asc(products.id))
    .limit(q.limit)
    .offset(q.offset);

  return {
    total: Number(total?.c ?? 0),
    items: rows.map((p) => ({
      id: p.id,
      siteId: p.siteId,
      name: p.name,
      slug: p.slug,
      priceCents: p.priceCents,
      currency: p.currency,
      enabled: p.enabled,
      stock: p.stock,
      sku: p.sku,
      categoryId: p.categoryId,
      description: clip(p.description, LIST_TEXT_CHARS),
      imageCount: Array.isArray(p.images) ? p.images.length : 0,
    })),
  };
}

export async function getProduct(scope: ReadScope, productId: number) {
  const [p] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), productScope(scope)))
    .limit(1);
  if (!p) throw notFound("Product");

  const [category] = p.categoryId
    ? await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.id, p.categoryId))
        .limit(1)
    : [];

  const variantRows = await db
    .select()
    .from(variants)
    .where(eq(variants.productId, p.id))
    .orderBy(asc(variants.position));

  /** On-hand per variant and location: the ledger summed, which is what "stock" means here. */
  const levels = variantRows.length
    ? await db
        .select({
          variantId: inventoryLedger.variantId,
          locationId: inventoryLedger.locationId,
          available: sql<string>`sum(${inventoryLedger.availableDelta})`,
        })
        .from(inventoryLedger)
        .where(
          inArray(
            inventoryLedger.variantId,
            variantRows.map((v) => v.id),
          ),
        )
        .groupBy(inventoryLedger.variantId, inventoryLedger.locationId)
    : [];

  const memberOf = await db
    .select({ id: collections.id, title: collections.title, type: collections.type })
    .from(collectionProducts)
    .innerJoin(collections, eq(collections.id, collectionProducts.collectionId))
    .where(eq(collectionProducts.productId, p.id));

  return {
    id: p.id,
    siteId: p.siteId,
    name: p.name,
    slug: p.slug,
    description: clip(p.description, DETAIL_TEXT_CHARS),
    priceCents: p.priceCents,
    currency: p.currency,
    sku: p.sku,
    stock: p.stock,
    enabled: p.enabled,
    images: p.images,
    category: category ?? null,
    suggestedProductIds: p.suggestedProductIds,
    collections: memberOf,
    variants: variantRows.map((v) => ({
      id: v.id,
      title: v.title,
      optionValues: v.optionValues,
      sku: v.sku,
      priceMinor: v.priceMinor,
      compareAtMinor: v.compareAtMinor,
      inventory: levels
        .filter((l) => l.variantId === v.id)
        .map((l) => ({ locationId: l.locationId, available: Number(l.available) })),
    })),
  };
}

/** A store the person can reach, or a 404 — for the per-store lists below. */
async function reachableSite(scope: ReadScope, siteId: number) {
  const [site] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, siteId), ownSitesForStaff(scope.orgId, scope.storeIds)))
    .limit(1);
  if (!site) throw notFound("Store");
}

export async function listCategories(scope: ReadScope, siteId: number) {
  await reachableSite(scope, siteId);
  return db
    .select({ id: categories.id, name: categories.name, slug: categories.slug, parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.siteId, siteId))
    .orderBy(asc(categories.name));
}

export async function listCollections(scope: ReadScope, siteId: number) {
  await reachableSite(scope, siteId);
  const rows = await db
    .select({
      id: collections.id,
      title: collections.title,
      handle: collections.handle,
      type: collections.type,
      publishedAt: collections.publishedAt,
    })
    .from(collections)
    .where(eq(collections.siteId, siteId))
    .orderBy(asc(collections.title));
  return rows.map((c) => ({ ...c, published: c.publishedAt != null, publishedAt: undefined }));
}

export async function listLocations(scope: ReadScope, siteId: number) {
  await reachableSite(scope, siteId);
  return db
    .select({ id: locations.id, name: locations.name, isDefault: locations.isDefault })
    .from(locations)
    .where(eq(locations.siteId, siteId))
    .orderBy(asc(locations.id));
}

/**
 * Product-level readiness issues — the rule-based findings (§9), never a
 * model's opinion. The catalog agent's best source of "what needs fixing",
 * because each finding names the field and what is expected of it.
 */
export async function catalogIssues(
  scope: ReadScope,
  filters: { siteId?: number; productId?: number; limit: number },
) {
  const reachable = new Set((await listStores(scope)).map((s) => s.id));
  if (filters.siteId != null && !reachable.has(filters.siteId)) throw notFound("Store");

  const { issues } = await computeReadiness(scope.orgId, {
    siteId: filters.siteId,
    productId: filters.productId,
  });
  const productIssues = issues.filter(
    (i) =>
      i.scope.productId != null &&
      (i.status === "open" || i.status === "assigned") &&
      (i.scope.siteId == null || reachable.has(i.scope.siteId)),
  );
  return {
    total: productIssues.length,
    items: productIssues.slice(0, filters.limit).map((i) => ({
      productId: i.scope.productId,
      code: i.code,
      severity: i.severity,
      title: i.title,
      fields: i.affectedFields,
      recommendation: i.recommendation,
    })),
  };
}
