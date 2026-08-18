import { invokeAction } from "./actions";
import { apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";
import type { Paginated } from "./types";

const COMMERCE_SECTION = "API §18";

/**
 * §18 is live in pieces, so the flags are per endpoint group rather than one
 * switch for the section.
 *
 * A single `COMMERCE_API_LIVE` would have to be wrong in one direction or the
 * other: `false` hides collections, customers, discounts, and variants, which
 * all work; `true` points screens at `/api/variants/:id` and
 * `/api/storefront/cart`, which **do not exist as routes at all**.
 *
 * Reads are routes. **Writes are actions** (§22 rule 1) — there is no
 * `PATCH /api/collections/:id`, and adding one would be the bolt-on this
 * architecture exists to prevent.
 */
const CATALOG_READ_API_LIVE = true;
const CUSTOMERS_API_LIVE = true;
const DISCOUNTS_API_LIVE = true;

export type ProductOption = {
  name: string;
  position: number;
  values: string[];
};

export type Variant = {
  id: number;
  productId: number;
  title: string;
  optionValues: Record<string, string>;
  sku: string | null;
  barcode: string | null;
  priceMinor: number;
  compareAtMinor: number | null;
  costMinor: number | null;
  weightGrams: number | null;
  requiresShipping: boolean;
  taxable: boolean;
  taxCode: string | null;
  imageId: string | null;
  inventoryPolicy: "deny" | "continue";
  inventoryLevels: { locationId: string; available: number; committed: number }[];
  position: number;
};

/** What `GET /api/products/:idOrSlug/variants` returns — the matrix *and* its axes. */
export type VariantMatrix = {
  productId: number;
  options: ProductOption[];
  variants: Variant[];
};

export type Collection = {
  id: number;
  storeId: number;
  title: string;
  handle: string;
  description: string | null;
  imageUrl: string | null;
  type: "manual" | "automated";
  rules?: {
    /**
     * Corrected 2026-08-18, and it was wrong in **both** directions.
     *
     * It offered `tag`, `vendor`, and `type`, which the server rejects by name
     * (`UNSUPPORTED_RULE_FIELDS` in `lib/commerce/collections.ts`) because the
     * product model has no such columns — a rule builder populated from this
     * type offered three options that could only ever fail. And it **omitted
     * `sku`**, which the server does support, so TypeScript forbade building a
     * rule on a field that works. A stale type is worse than a missing one.
     */
    field: "title" | "price" | "stock" | "sku";
    op: "eq" | "contains" | "gt" | "lt" | "starts_with";
    value: string;
  }[];
  rulesMatch?: "all" | "any";
  sortOrder:
    | "manual"
    | "best_selling"
    | "price_asc"
    | "price_desc"
    | "created_desc";
  productCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Customer = {
  id: number;
  storeId: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  acceptsMarketing: boolean;
  marketingConsentAt: string | null;
  tags: string[];
  note: string | null;
  ordersCount: number;
  totalSpentMinor: number;
  createdAt: string;
  updatedAt: string;
};

export type Discount = {
  id: number;
  siteId: number;
  /** Null means **automatic** — applied without the shopper typing anything. */
  code: string | null;
  title: string;
  type: "percentage" | "fixed" | "free_shipping";
  /** Basis points: 1500 is 15%. Integer, never a float (D31). */
  percentageBps: number | null;
  /** Minor units, for `fixed`. */
  valueMinor: number | null;
  appliesToScope: "order" | "products" | "collections";
  appliesToIds: number[];
  minimumSubtotalMinor: number | null;
  customerEligibility: "all" | "specific";
  eligibleCustomerIds: number[];
  usageLimit: number | null;
  usageLimitPerCustomer: number | null;
  /** All default false — stacking is opted into, never inherited (§18.5). */
  combinesWithProduct: boolean;
  combinesWithOrder: boolean;
  combinesWithShipping: boolean;
  /** The merchant's on/off switch. `status` is derived from this plus the dates. */
  enabled: boolean;
  /** Derived per request from `enabled` and the window — never stored. */
  status: "active" | "scheduled" | "expired" | "disabled";
  usedCount: number;
  /** A fully-redeemed code looks active until someone tries it — so it is stated. */
  exhausted: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getVariantMatrix(
  productIdOrSlug: string | number,
  query?: { siteId?: number },
  init?: RequestInit,
) {
  return callWhenLive(CATALOG_READ_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<VariantMatrix>(
      `/api/products/${encodeURIComponent(String(productIdOrSlug))}/variants`,
      query,
      init,
    ),
  );
}

export function listCollections(
  query?: { siteId?: number; type?: Collection["type"]; q?: string; page?: number; limit?: number },
  init?: RequestInit,
) {
  return callWhenLive(CATALOG_READ_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<Paginated<Collection>>("/api/collections", query, init),
  );
}

export function getCollection(idOrHandle: string | number, init?: RequestInit) {
  return callWhenLive(CATALOG_READ_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<Collection>(
      `/api/collections/${encodeURIComponent(String(idOrHandle))}`,
      undefined,
      init,
    ),
  );
}

export function listCustomers(
  query?: { siteId?: number; q?: string; page?: number; limit?: number },
  init?: RequestInit,
) {
  return callWhenLive(CUSTOMERS_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<Paginated<Customer>>("/api/customers", query, init),
  );
}

export function getCustomer(id: number, init?: RequestInit) {
  return callWhenLive(CUSTOMERS_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<Customer>(`/api/customers/${id}`, undefined, init),
  );
}

export function listDiscounts(
  query?: { status?: Discount["status"]; q?: string; page?: number; limit?: number },
  init?: RequestInit,
) {
  return callWhenLive(DISCOUNTS_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<Paginated<Discount>>("/api/discounts", query, init),
  );
}

export type DiscountRedemption = {
  id: number;
  discountId: number;
  orderId: number;
  amountMinor: number;
  createdAt: string;
};

/** What `GET /api/discounts/:id` returns — the discount plus redemption history. */
export type DiscountDetail = Discount & {
  totalDiscountedMinor: number;
  redemptions: DiscountRedemption[];
};

export function getDiscount(id: number, init?: RequestInit) {
  return callWhenLive(DISCOUNTS_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<DiscountDetail>(`/api/discounts/${id}`, undefined, init),
  );
}

export type Location = {
  id: string;
  siteId: number;
  name: string;
  isDefault: boolean;
};

export function listLocations(query?: { siteId?: number }, init?: RequestInit) {
  return callWhenLive(CATALOG_READ_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<{ items: Location[] }>("/api/locations", query, init),
  );
}

// ---------------------------------------------------------------------------
// Writes — actions, never routes (§22 rule 1)
// ---------------------------------------------------------------------------

/**
 * Regenerate a product's variant matrix from its option axes.
 *
 * There is deliberately no "create one variant" call: a variant that does not
 * correspond to an option combination has no coherent identity.
 */
export type SetProductOptionsResult = {
  productId: number;
  created: number;
  kept: number;
  orphaned: { id: number; title: string }[];
};

export function setProductOptions(
  body: {
    productId: number;
    options: ProductOption[];
    defaultPriceMinor?: number;
  },
  init?: RequestInit,
) {
  return invokeAction<SetProductOptionsResult>("catalog.setProductOptions", body, init);
}

export function updateVariant(
  body: { variantId: number } & Partial<
    Pick<
      Variant,
      | "sku"
      | "barcode"
      | "priceMinor"
      | "compareAtMinor"
      | "costMinor"
      | "weightGrams"
      | "requiresShipping"
      | "taxable"
      | "taxCode"
      | "inventoryPolicy"
    >
  >,
  init?: RequestInit,
) {
  return invokeAction<Variant>("catalog.updateVariant", body, init);
}

/**
 * Collection fields the actions accept. Note `published` — a boolean the action
 * turns into a `publishedAt` timestamp — and `siteId`, which is what a write
 * names its store, even though reads return it as `storeId`.
 */
export type CollectionInput = {
  title: string;
  handle?: string;
  description?: string | null;
  imageUrl?: string | null;
  type?: Collection["type"];
  rules?: NonNullable<Collection["rules"]>;
  rulesMatch?: NonNullable<Collection["rulesMatch"]>;
  sortOrder?: Collection["sortOrder"];
  published?: boolean;
};

export function createCollection(
  body: { siteId: number } & CollectionInput,
  init?: RequestInit,
) {
  return invokeAction<Collection>("catalog.createCollection", body, init);
}

export function updateCollection(
  body: { collectionId: number } & Partial<CollectionInput>,
  init?: RequestInit,
) {
  return invokeAction<Collection>("catalog.updateCollection", body, init);
}

export function deleteCollection(body: { collectionId: number }, init?: RequestInit) {
  return invokeAction<{ deleted: true; id: number }>("catalog.deleteCollection", body, init);
}

export type CustomerInput = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  acceptsMarketing?: boolean;
  tags?: string[];
  note?: string | null;
};

export function createCustomer(
  body: { siteId: number } & CustomerInput,
  init?: RequestInit,
) {
  return invokeAction<Customer>("customers.create", body, init);
}

export function updateCustomer(
  body: { customerId: number } & Partial<CustomerInput>,
  init?: RequestInit,
) {
  return invokeAction<Customer>("customers.update", body, init);
}

export function createDiscount(
  body: { siteId: number } & DiscountInput,
  init?: RequestInit,
) {
  return invokeAction<Discount>("discounts.create", body, init);
}

export function updateDiscount(
  body: { discountId: number } & Partial<DiscountInput>,
  init?: RequestInit,
) {
  return invokeAction<Discount>("discounts.update", body, init);
}

export function deleteDiscount(body: { discountId: number }, init?: RequestInit) {
  return invokeAction<{ deleted: true }>("discounts.delete", body, init);
}

export function setCollectionProducts(
  body: { collectionId: number; productIds: number[] },
  init?: RequestInit,
) {
  return invokeAction("catalog.setCollectionProducts", body, init);
}

export function adjustInventory(
  body: {
    variantId: number;
    locationId: string;
    delta: number;
    reason?: string;
  },
  init?: RequestInit,
) {
  return invokeAction("inventory.adjust", body, init);
}

export type DiscountInput = {
  code?: string | null;
  title: string;
  type: Discount["type"];
  percentageBps?: number | null;
  valueMinor?: number | null;
  appliesToScope?: Discount["appliesToScope"];
  appliesToIds?: number[];
  minimumSubtotalMinor?: number | null;
  customerEligibility?: Discount["customerEligibility"];
  eligibleCustomerIds?: number[];
  usageLimit?: number | null;
  usageLimitPerCustomer?: number | null;
  combinesWithProduct?: boolean;
  combinesWithOrder?: boolean;
  combinesWithShipping?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  enabled?: boolean;
};

/**
 * **There is no dashboard cart service, and that is not an omission.** Carts are
 * storefront state (`/_sites/:site/api/cart`, §23 "do not build these"), created
 * by shoppers rather than by staff. The previous `createCart()` here pointed at
 * `/api/storefront/cart`, which has never existed as a route.
 *
 * If a merchant-side draft order is ever specced it gets its own action, not a
 * dashboard call into a storefront endpoint.
 */

/**
 * `POST /api/discounts/validate` — would this code apply, and for how much?
 *
 * **A preview.** It writes nothing, redeems nothing, and consumes no usage
 * allowance, so a merchant can test a code without burning a single-use one or
 * inflating its redemption count. It runs the *same* `evaluateDiscounts` the
 * cart and checkout use — a second implementation here could disagree with the
 * one that actually charges money.
 *
 * Added 2026-08-10: the route had shipped with no typed caller, so no screen
 * could reach it. `/dashboard/discounts` is where it belongs.
 */
export type DiscountPreview = {
  applied: {
    discountId: number;
    code: string | null;
    title: string;
    type: string;
    /** Zero for `free_shipping`, which acts on shipping rather than the subtotal. */
    amountMinor: number;
    freeShipping: boolean;
  }[];
  /** Every code that did **not** apply, each with a reason worth showing. */
  rejected: { code: string; reason: string }[];
  totalDiscountMinor: number;
  subtotalMinor: number;
  subtotalAfterDiscountMinor: number;
  preview: true;
};

export function previewDiscounts(
  body: {
    siteId: number;
    codes: string[];
    subtotalMinor: number;
    /** Optional — omit for an order-scoped check that ignores per-product rules. */
    lines?: { productId: number; lineTotalMinor: number }[];
    customerId?: number | null;
  },
  init?: RequestInit,
) {
  return callWhenLive(DISCOUNTS_API_LIVE, COMMERCE_SECTION, () =>
    apiPost<DiscountPreview>("/api/discounts/validate", body, init),
  );
}

/**
 * `GET /api/inventory/levels` — stock across products, filterable (§18.1).
 *
 * Distinct from the `inventoryLevels` field on a {@link Variant}, which answers
 * "what is the stock for *this* product". This answers "what is low across the
 * whole catalog", which is the question the inventory screen exists for and
 * cannot be assembled from per-product reads without fetching everything.
 *
 * **Levels are summed from the ledger, never read from a column**, so this
 * always agrees with the entry history. If a total ever disagrees with the
 * ledger, the ledger is right.
 *
 * Added 2026-08-10: the route had shipped with no typed caller.
 */
export type InventoryLevelRow = {
  variantId: number;
  productId: number;
  productName: string;
  title: string;
  sku: string | null;
  inventoryPolicy: "deny" | "continue";
  levels: { locationId: number; available: number; committed: number }[];
  /** Summed across locations, or across the one location when filtered. */
  totalAvailable: number;
  totalCommitted: number;
};

export function listInventoryLevels(
  params: {
    siteId?: number;
    productId?: number;
    locationId?: number;
    /** Returns only rows at or below this total. Applied **after** summing. */
    lowStock?: number;
    page?: number;
    limit?: number;
  } = {},
  init?: RequestInit,
) {
  return callWhenLive(CATALOG_READ_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<{ items: InventoryLevelRow[]; page: number; limit: number }>(
      "/api/inventory/levels",
      params,
      init,
    ),
  );
}
