import { and, asc, count, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { badRequest, dateRange, enumParam, intParam, notFound, tenantBaseUrl } from "@/lib/api";
import {
  agentTraffic,
  categories,
  db,
  digitalAssets,
  membershipTiers,
  orders,
  productDigitalAssets,
  products,
  sites,
  type Category,
  type Order,
  type Product,
  type Site,
} from "@/lib/db";
import { ownSites, siteScope, siteScopeForStaff, type OrgId } from "@/lib/tenancy";

// ---------- URLs ----------

export function storefrontUrl(site: Pick<Site, "slug" | "customDomain">): string {
  if (site.customDomain) return `https://${site.customDomain}`;
  return tenantBaseUrl(site.slug);
}

// ---------- resolvers (id or slug) ----------

const isNumeric = (s: string) => /^\d+$/.test(s);

/**
 * Resolvers take `orgId` as a **required** argument. There is no unscoped
 * variant, so "forgot the org filter" is not a mistake this file permits.
 *
 * All three answer `404`, never `403`, for a row belonging to another org.
 * A 403 would confirm the id exists, turning these into an enumeration oracle
 * across tenants.
 */

export async function resolveSite(idOrSlug: string, orgId: OrgId): Promise<Site> {
  const cond = isNumeric(idOrSlug) ? eq(sites.id, Number(idOrSlug)) : eq(sites.slug, idOrSlug);
  const [row] = await db
    .select()
    .from(sites)
    .where(and(cond, ownSites(orgId)))
    .limit(1);
  if (!row) throw notFound("Site");
  return row;
}

export async function resolveCategory(
  idOrSlug: string,
  orgId: OrgId,
  siteId?: number,
): Promise<Category> {
  const cond = isNumeric(idOrSlug)
    ? eq(categories.id, Number(idOrSlug))
    : siteId != null
      ? and(eq(categories.slug, idOrSlug), eq(categories.siteId, siteId))
      : eq(categories.slug, idOrSlug);
  const [row] = await db
    .select()
    .from(categories)
    .where(and(cond, siteScope(orgId, categories.siteId)))
    .limit(1);
  if (!row) throw notFound("Category");
  return row;
}

export async function resolveProduct(
  idOrSlug: string,
  orgId: OrgId,
  siteId?: number,
): Promise<Product> {
  const cond = isNumeric(idOrSlug)
    ? eq(products.id, Number(idOrSlug))
    : siteId != null
      ? and(eq(products.slug, idOrSlug), eq(products.siteId, siteId))
      : eq(products.slug, idOrSlug);
  const [row] = await db
    .select()
    .from(products)
    .where(and(cond, siteScope(orgId, products.siteId)))
    .limit(1);
  if (!row) throw notFound("Product");
  return row;
}

// ---------- refs ----------

export const siteRef = (s: Site) => ({ id: s.id, name: s.name, slug: s.slug });
export const categoryRef = (c: Category) => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  parentId: c.parentId,
});
export const productRef = (p: Product) => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  priceCents: p.priceCents,
  images: p.images,
});

async function sitesById(ids: number[]): Promise<Map<number, Site>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(sites).where(sql`${sites.id} in ${ids}`);
  return new Map(rows.map((s) => [s.id, s]));
}

async function categoriesById(ids: number[]): Promise<Map<number, Category>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(categories).where(sql`${categories.id} in ${ids}`);
  return new Map(rows.map((c) => [c.id, c]));
}

async function productsById(ids: number[]): Promise<Map<number, Product>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(products).where(sql`${products.id} in ${ids}`);
  return new Map(rows.map((p) => [p.id, p]));
}

const uniq = (ns: (number | null)[]) => [...new Set(ns.filter((n): n is number => n != null))];

// ---------- serializers ----------

export async function serializeSites(list: Site[]) {
  const ids = list.map((s) => s.id);
  const prodCounts = new Map<number, number>();
  const catCounts = new Map<number, number>();
  if (ids.length > 0) {
    const pc = await db
      .select({ siteId: products.siteId, c: count() })
      .from(products)
      .where(sql`${products.siteId} in ${ids}`)
      .groupBy(products.siteId);
    for (const r of pc) prodCounts.set(r.siteId, Number(r.c));
    const cc = await db
      .select({ siteId: categories.siteId, c: count() })
      .from(categories)
      .where(sql`${categories.siteId} in ${ids}`)
      .groupBy(categories.siteId);
    for (const r of cc) catCounts.set(r.siteId, Number(r.c));
  }
  return list.map((s) => ({
    ...s,
    themeId: s.themeId ?? "studio",
    productCount: prodCounts.get(s.id) ?? 0,
    categoryCount: catCounts.get(s.id) ?? 0,
    storefrontUrl: storefrontUrl(s),
  }));
}

export async function serializeSite(site: Site) {
  const [s] = await serializeSites([site]);
  return s;
}

export async function serializeProducts(list: Product[]) {
  const siteMap = await sitesById(uniq(list.map((p) => p.siteId)));
  const catMap = await categoriesById(uniq(list.map((p) => p.categoryId)));
  return list.map((p) => {
    const site = siteMap.get(p.siteId);
    const cat = p.categoryId != null ? catMap.get(p.categoryId) : undefined;
    return {
      ...p,
      site: site ? siteRef(site) : null,
      category: cat ? categoryRef(cat) : null,
    };
  });
}

export async function serializeProductDetail(p: Product) {
  const [base] = await serializeProducts([p]);
  const relatedIds = uniq([...p.suggestedProductIds, ...p.addOns.map((a) => a.productId)]);
  const related = await productsById(relatedIds);
  const attachments = await db
    .select({
      attachmentId: productDigitalAssets.id,
      assetId: digitalAssets.id,
      fileName: digitalAssets.fileName,
      contentType: digitalAssets.contentType,
      sizeBytes: digitalAssets.sizeBytes,
      label: digitalAssets.label,
      variantId: productDigitalAssets.variantId,
      position: productDigitalAssets.position,
    })
    .from(productDigitalAssets)
    .innerJoin(digitalAssets, eq(digitalAssets.id, productDigitalAssets.assetId))
    .where(eq(productDigitalAssets.productId, p.id))
    .orderBy(asc(productDigitalAssets.position), asc(productDigitalAssets.id));
  return {
    ...base,
    digitalAssets: attachments,
    suggestedProducts: p.suggestedProductIds
      .map((id) => related.get(id))
      .filter((x): x is Product => !!x)
      .map(productRef),
    addOns: p.addOns.map((a) => {
      const prod = related.get(a.productId);
      return { ...a, product: prod ? productRef(prod) : null };
    }),
  };
}

export async function serializeCategories(list: Category[]) {
  const siteMap = await sitesById(uniq(list.map((c) => c.siteId)));
  const parentMap = await categoriesById(uniq(list.map((c) => c.parentId)));
  const ids = list.map((c) => c.id);
  const prodCounts = new Map<number, number>();
  if (ids.length > 0) {
    const pc = await db
      .select({ categoryId: products.categoryId, c: count() })
      .from(products)
      .where(sql`${products.categoryId} in ${ids}`)
      .groupBy(products.categoryId);
    for (const r of pc) if (r.categoryId != null) prodCounts.set(r.categoryId, Number(r.c));
  }
  return list.map((c) => {
    const site = siteMap.get(c.siteId);
    const parent = c.parentId != null ? parentMap.get(c.parentId) : undefined;
    return {
      ...c,
      productCount: prodCounts.get(c.id) ?? 0,
      site: site ? siteRef(site) : null,
      parent: parent ? { id: parent.id, name: parent.name, slug: parent.slug } : null,
    };
  });
}

export async function serializeCategoryDetail(c: Category) {
  const [base] = await serializeCategories([c]);
  const children = await db
    .select({ id: categories.id, name: categories.name, slug: categories.slug })
    .from(categories)
    .where(eq(categories.parentId, c.id));
  return { ...base, children };
}

export async function serializeOrders(list: Order[]) {
  const siteMap = await sitesById(uniq(list.map((o) => o.siteId)));
  const prodMap = await productsById(uniq(list.map((o) => o.productId)));
  return list.map((o) => {
    const site = o.siteId != null ? siteMap.get(o.siteId) : undefined;
    const prod = o.productId != null ? prodMap.get(o.productId) : undefined;
    return {
      id: o.id,
      siteId: o.siteId,
      productId: o.productId,
      quantity: o.quantity,
      status: o.status,
      amountCents: o.amountCents,
      currency: o.currency,
      provider: o.provider,
      txHash: o.txHash,
      /**
       * §18.7. Added beside the v1 fields rather than replacing them — `status`
       * keeps its original meaning (the payment outcome) and existing screens
       * that branch on it are untouched. Money and fulfillment are separate axes.
       */
      financialStatus: o.financialStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      subtotalMinor: o.subtotalMinor,
      discountMinor: o.discountMinor,
      taxMinor: o.taxMinor,
      shippingMinor: o.shippingMinor,
      refundedMinor: o.refundedMinor,
      email: o.email,
      cancelledAt: o.cancelledAt,
      cancelReason: o.cancelReason,
      agent: {
        userAgent: o.agentUserAgent,
        name: o.agentName,
        walletAddress: o.agentWalletAddress,
      },
      product: prod ? { id: prod.id, name: prod.name, slug: prod.slug } : null,
      site: site ? siteRef(site) : null,
      createdAt: o.createdAt,
    };
  });
}

// ---------- aggregates ----------

/**
 * Every aggregate is org-scoped. `orgId` is required and first, so an
 * accidental `trafficStats({ from })` is a compile error rather than a query
 * that quietly totals every tenant on the platform.
 */
type RangeOpts = { orgId: OrgId; siteId?: number; from?: Date; to?: Date };

function trafficWhere({ orgId, siteId, from, to }: RangeOpts): SQL | undefined {
  // Org scope is unconditional and first — `siteId` narrows it, never replaces it.
  const conds: SQL[] = [siteScope(orgId, agentTraffic.siteId)];
  if (siteId != null) conds.push(eq(agentTraffic.siteId, siteId));
  if (from) conds.push(sql`${agentTraffic.createdAt} >= ${from.toISOString()}`);
  if (to) conds.push(sql`${agentTraffic.createdAt} <= ${to.toISOString()}`);
  return conds.length ? and(...conds) : undefined;
}

export async function trafficStats(opts: RangeOpts) {
  const where = trafficWhere(opts);
  const [totalRow] = await db.select({ c: count() }).from(agentTraffic).where(where);
  const last7dWhere = trafficWhere({
    ...opts,
    from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  });
  const [last7dRow] = await db.select({ c: count() }).from(agentTraffic).where(last7dWhere);
  const byDay = await db
    .select({
      date: sql<string>`to_char(${agentTraffic.createdAt}, 'YYYY-MM-DD')`,
      count: count(),
    })
    .from(agentTraffic)
    .where(where)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const byAgent = await db
    .select({ agentName: agentTraffic.agentName, count: count() })
    .from(agentTraffic)
    .where(where)
    .groupBy(agentTraffic.agentName)
    .orderBy(sql`2 desc`);
  return {
    total: Number(totalRow?.c ?? 0),
    last7d: Number(last7dRow?.c ?? 0),
    byDay: byDay.map((r) => ({ date: r.date, count: Number(r.count) })),
    byAgent: byAgent.map((r) => ({ agentName: r.agentName, count: Number(r.count) })),
  };
}

function ordersWhere({ orgId, siteId, from, to }: RangeOpts, extra?: SQL): SQL | undefined {
  const conds: SQL[] = [siteScope(orgId, orders.siteId)];
  if (siteId != null) conds.push(eq(orders.siteId, siteId));
  if (from) conds.push(sql`${orders.createdAt} >= ${from.toISOString()}`);
  if (to) conds.push(sql`${orders.createdAt} <= ${to.toISOString()}`);
  if (extra) conds.push(extra);
  return conds.length ? and(...conds) : undefined;
}

/** Successful-order balances, split x402 vs fiat, optionally per site. */
export async function balanceStats(opts: RangeOpts) {
  const where = ordersWhere(opts, eq(orders.status, "success"));
  const rows = await db
    .select({
      siteId: orders.siteId,
      provider: orders.provider,
      sum: sql<string>`coalesce(sum(${orders.amountCents}), 0)`,
      count: count(),
    })
    .from(orders)
    .where(where)
    .groupBy(orders.siteId, orders.provider);

  const bySite = new Map<
    number,
    { x402Cents: number; fiatCents: number; orderCount: number }
  >();
  let x402Cents = 0;
  let fiatCents = 0;
  let orderCount = 0;
  for (const r of rows) {
    const amount = Number(r.sum);
    const n = Number(r.count);
    orderCount += n;
    if (r.provider === "x402") x402Cents += amount;
    else fiatCents += amount;
    if (r.siteId != null) {
      const entry = bySite.get(r.siteId) ?? { x402Cents: 0, fiatCents: 0, orderCount: 0 };
      if (r.provider === "x402") entry.x402Cents += amount;
      else entry.fiatCents += amount;
      entry.orderCount += n;
      bySite.set(r.siteId, entry);
    }
  }
  return { totalCents: x402Cents + fiatCents, x402Cents, fiatCents, orderCount, bySite };
}

/** Shared filter set for a site's transaction list and its CSV export. */
export function transactionFilters(siteId: number, sp: URLSearchParams): SQL | undefined {
  const conds: SQL[] = [eq(orders.siteId, siteId)];
  const status = sp.get("status");
  if (status) {
    if (!["pending", "success", "cancel", "failed"].includes(status))
      throw badRequest("invalid status filter");
    conds.push(eq(orders.status, status as "pending" | "success" | "cancel" | "failed"));
  }
  const { from, to } = dateRange(sp);
  if (from) conds.push(gte(orders.createdAt, from));
  if (to) conds.push(lte(orders.createdAt, to));
  const q = sp.get("q");
  if (q) conds.push(or(ilike(products.name, `%${q}%`), ilike(orders.txHash, `%${q}%`))!);
  return and(...conds);
}

// ---------- order list (§13) ----------

const ORDER_STATUSES = ["pending", "success", "cancel", "failed"] as const;
const FINANCIAL_STATUSES = ["pending", "paid", "partially_refunded", "refunded", "voided"] as const;
const FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
  "not_required",
] as const;
const PROVIDERS = ["x402", "stripe"] as const;

/**
 * §13's speculative filters, refused **by name** rather than left unread.
 *
 * Leaving them unread is the same silent no-op as accepting them: a caller
 * asking for `?exception=true` would be handed every order and have no way to
 * know the filter never ran. Each one names what to use instead, or why there is
 * nothing to use.
 */
const UNSUPPORTED_ORDER_FILTERS: Record<string, string> = {
  channelId: "there is no channel model yet (§11 is planned)",
  environment: "orders carry no test/production flag — test orders are excluded at write time",
  exception: "orders carry no exception column; filter on status or fulfillmentStatus instead",
  paymentRail: "use `provider` (x402 | stripe)",
  paymentStatus: "use `financialStatus`",
};

/**
 * Shared filter set for `GET /api/orders` and its CSV export.
 *
 * **Both routes call this or neither is trustworthy.** An export that quietly
 * applied a wider filter than the list it was launched from hands a merchant a
 * file that disagrees with the screen they were reading — and a CSV is what ends
 * up in the accountant's inbox, so it is the copy that has to be right.
 *
 * Scope is built here from the session rather than passed in already-composed,
 * so a caller cannot supply a filter set that forgot its tenancy (`lib/tenancy`).
 *
 * The filters are the columns that exist. §13 was written against a planned
 * schema; `channelId`, `environment`, `paymentRail`, `paymentStatus`, and
 * `exception` have nothing behind them and are refused.
 */
export function orderListFilters(
  scope: { orgId: OrgId; storeIds: number[] | "all" },
  sp: URLSearchParams,
): SQL {
  for (const [name, why] of Object.entries(UNSUPPORTED_ORDER_FILTERS)) {
    if (sp.has(name)) throw badRequest(`${name} is not a supported filter: ${why}`);
  }

  // Org scope first and unconditional; every filter below only narrows it.
  // Staff scoped to a subset of stores never see the rest of the org's orders.
  const conds: SQL[] = [siteScopeForStaff(scope.orgId, scope.storeIds, orders.siteId)];

  const siteId = intParam(sp, "siteId");
  if (siteId != null) conds.push(eq(orders.siteId, siteId));
  const customerId = intParam(sp, "customerId");
  if (customerId != null) conds.push(eq(orders.customerId, customerId));
  const productId = intParam(sp, "productId");
  if (productId != null) conds.push(eq(orders.productId, productId));

  const status = enumParam(sp, "status", ORDER_STATUSES);
  if (status) conds.push(eq(orders.status, status));
  const financialStatus = enumParam(sp, "financialStatus", FINANCIAL_STATUSES);
  if (financialStatus) conds.push(eq(orders.financialStatus, financialStatus));
  const fulfillmentStatus = enumParam(sp, "fulfillmentStatus", FULFILLMENT_STATUSES);
  if (fulfillmentStatus) conds.push(eq(orders.fulfillmentStatus, fulfillmentStatus));
  const provider = enumParam(sp, "provider", PROVIDERS);
  if (provider) conds.push(eq(orders.provider, provider));

  const { from, to } = dateRange(sp);
  if (from) conds.push(gte(orders.createdAt, from));
  if (to) conds.push(lte(orders.createdAt, to));

  /**
   * `q` searches what a merchant actually has in hand: the order number from a
   * support email, the buyer's address, the transaction hash, the product name.
   * `orders.email` is the copy frozen at checkout, so it still finds the order
   * after the customer record is erased (§18.3).
   *
   * Callers must `leftJoin(products)` — the product-name term reaches across it.
   */
  const q = sp.get("q")?.trim();
  if (q) {
    const like = `%${q}%`;
    const terms: SQL[] = [
      ilike(orders.email, like),
      ilike(orders.txHash, like),
      ilike(products.name, like),
      ilike(orders.agentName, like),
    ];
    if (/^\d+$/.test(q)) terms.push(eq(orders.id, Number(q)));
    conds.push(or(...terms)!);
  }

  return and(...conds)!;
}

// ---------- slug helpers ----------

/** Returns `base`, or `base-2`, `base-3`, … — first slug free on the site. */
export async function uniqueProductSlug(siteId: number, base: string): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ slug: products.slug })
        .from(products)
        .where(and(eq(products.siteId, siteId), sql`${products.slug} like ${base + "%"}`))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function uniqueCategorySlug(siteId: number, base: string): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ slug: categories.slug })
        .from(categories)
        .where(and(eq(categories.siteId, siteId), sql`${categories.slug} like ${base + "%"}`))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function pendingCountsBySite(orgId: OrgId): Promise<Map<number, number>> {
  const rows = await db
    .select({ siteId: orders.siteId, c: count() })
    .from(orders)
    .where(and(eq(orders.status, "pending"), siteScope(orgId, orders.siteId)))
    .groupBy(orders.siteId);
  const map = new Map<number, number>();
  for (const r of rows) if (r.siteId != null) map.set(r.siteId, Number(r.c));
  return map;
}

/**
 * Rejects a product's membership tier ids unless they belong to the target site.
 *
 * **This closes a cross-tenant write.** `requiresTierId` and `grantsTierId`
 * became settable through `productCreateSchema` on 2026-08-10; before that zod
 * stripped them, so nothing validated them and nothing needed to. Both columns
 * carry a foreign key to `membership_tiers`, which proves the tier *exists* and
 * says nothing about who owns it — so any merchant could name any tier id in
 * the database.
 *
 * `grantsTierId` is the sharp end: `grantMembershipsForOrder` joins the tier
 * with no site scope of its own, so a purchase would write a membership row
 * pointing at another merchant's tier and hand that tier's **name** back to the
 * buying merchant's shopper. `requiresTierId` is milder — a product gated on a
 * tier your customers can never hold — but it is the same mistake.
 *
 * Validated here at the write rather than patched at the read, because the read
 * paths are many and the write paths are two.
 */
export async function assertTiersOnSite(
  orgId: OrgId,
  siteId: number,
  tierIds: (number | null | undefined)[],
) {
  const wanted = [...new Set(tierIds.filter((id): id is number => id != null))];
  if (wanted.length === 0) return;

  const rows = await db
    .select({ id: membershipTiers.id, siteId: membershipTiers.siteId })
    .from(membershipTiers)
    .where(
      and(inArray(membershipTiers.id, wanted), siteScope(orgId, membershipTiers.siteId)),
    );

  const found = new Map(rows.map((r) => [r.id, r.siteId]));
  for (const id of wanted) {
    const owned = found.get(id);
    // Not found and not-yours are the same answer on purpose: confirming a tier
    // exists on someone else's store is itself a leak.
    if (owned == null) throw notFound(`Membership tier ${id}`);
    if (owned !== siteId) throw badRequest(`membership tier ${id} belongs to a different site`);
  }
}
