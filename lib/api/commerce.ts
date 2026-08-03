import { invokeAction } from "./actions";
import { apiGet } from "./client";
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
    field: "title" | "tag" | "price" | "stock" | "vendor" | "type";
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
  code: string | null;
  automatic: boolean;
  type: "percentage" | "fixed" | "free_shipping" | "bogo";
  valueMinor: number | null;
  percentage: number | null;
  status: "draft" | "active" | "expired";
  usageLimit: number | null;
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
export function setProductOptions(
  body: { productId: number; options: ProductOption[] },
  init?: RequestInit,
) {
  return invokeAction<VariantMatrix>("catalog.setProductOptions", body, init);
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
  body: { siteId: number } & Record<string, unknown>,
  init?: RequestInit,
) {
  return invokeAction<Discount>("discounts.create", body, init);
}

export function updateDiscount(
  body: { discountId: number } & Record<string, unknown>,
  init?: RequestInit,
) {
  return invokeAction<Discount>("discounts.update", body, init);
}

export function deleteDiscount(body: { discountId: number }, init?: RequestInit) {
  return invokeAction<{ deleted: true }>("discounts.delete", body, init);
}

/**
 * **There is no dashboard cart service, and that is not an omission.** Carts are
 * storefront state (`/_sites/:site/api/cart`, §23 "do not build these"), created
 * by shoppers rather than by staff. The previous `createCart()` here pointed at
 * `/api/storefront/cart`, which has never existed as a route.
 *
 * If a merchant-side draft order is ever specced it gets its own action, not a
 * dashboard call into a storefront endpoint.
 */
