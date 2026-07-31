import { apiGet, apiPatch, apiPost } from "./client";
import { callWhenLive } from "./planned";

const COMMERCE_SECTION = "API §18";
const COMMERCE_API_LIVE = false;

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
};

export type Customer = {
  id: number;
  storeId: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  acceptsMarketing: boolean;
  tags: string[];
  note: string | null;
  ordersCount: number;
  totalSpentMinor: number;
  createdAt: string;
};

export type Discount = {
  id: number;
  code: string | null;
  automatic: boolean;
  type: "percentage" | "fixed" | "free_shipping" | "bogo";
  valueMinor: number | null;
  percentage: number | null;
  status: "draft" | "active" | "expired";
  startsAt: string | null;
  endsAt: string | null;
};

export type Cart = {
  id: string;
  storeId: number;
  token: string;
  status: "open" | "abandoned" | "converted";
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  lines: {
    variantId: number;
    quantity: number;
    unitPriceMinor: number;
    addOnIds?: number[];
  }[];
};

export function listVariants(productId: number, init?: RequestInit) {
  return callWhenLive(COMMERCE_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<{ items: Variant[] }>(`/api/products/${productId}/variants`, undefined, init),
  );
}

export function createVariants(
  productId: number,
  body: Partial<Variant>,
  init?: RequestInit,
) {
  return callWhenLive(COMMERCE_API_LIVE, COMMERCE_SECTION, () =>
    apiPost<Variant>(`/api/products/${productId}/variants`, body, init),
  );
}

export function regenerateOptions(
  productId: number,
  body: { options: ProductOption[] },
  init?: RequestInit,
) {
  return callWhenLive(COMMERCE_API_LIVE, COMMERCE_SECTION, () =>
    apiPost<{ items: Variant[] }>(`/api/products/${productId}/options`, body, init),
  );
}

export function updateVariant(id: number, body: Partial<Variant>, init?: RequestInit) {
  return callWhenLive(COMMERCE_API_LIVE, COMMERCE_SECTION, () =>
    apiPatch<Variant>(`/api/variants/${id}`, body, init),
  );
}

export function listCollections(init?: RequestInit) {
  return callWhenLive(COMMERCE_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<{ items: Collection[] }>("/api/collections", undefined, init),
  );
}

export function listCustomers(init?: RequestInit) {
  return callWhenLive(COMMERCE_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<{ items: Customer[] }>("/api/customers", undefined, init),
  );
}

export function listDiscounts(init?: RequestInit) {
  return callWhenLive(COMMERCE_API_LIVE, COMMERCE_SECTION, () =>
    apiGet<{ items: Discount[] }>("/api/discounts", undefined, init),
  );
}

export function createCart(body: { storeId: number }, init?: RequestInit) {
  return callWhenLive(COMMERCE_API_LIVE, COMMERCE_SECTION, () =>
    apiPost<Cart>("/api/storefront/cart", body, init),
  );
}
