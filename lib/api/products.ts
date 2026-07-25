import { apiDelete, apiGet, apiPatch, apiPost, buildQuery } from "./client";
import type { Paginated, Product } from "./types";

/**
 * Product slugs are unique per site, not globally — every by-slug call must carry
 * siteId or the API may resolve a same-slug product on a different site.
 */
type Scope = { siteId?: number };
const scoped = (idOrSlug: string, scope?: Scope) =>
  `/api/products/${encodeURIComponent(idOrSlug)}${buildQuery(scope)}`;

export type ProductsQuery = {
  q?: string;
  siteId?: number;
  categoryId?: number;
  enabled?: boolean;
  inStock?: boolean;
  sort?: "name" | "priceCents" | "-priceCents" | "createdAt" | "-createdAt";
  page?: number;
  limit?: number;
};

export function listProducts(query?: ProductsQuery, init?: RequestInit) {
  return apiGet<Paginated<Product>>("/api/products", query, init);
}

export function getProduct(
  idOrSlug: string,
  query?: { siteId?: number },
  init?: RequestInit,
) {
  return apiGet<Product>(
    `/api/products/${encodeURIComponent(idOrSlug)}`,
    query,
    init,
  );
}

export function createProduct(
  body: Partial<Product> & {
    siteId: number;
    name: string;
    priceCents: number;
  },
  init?: RequestInit,
) {
  return apiPost<Product>("/api/products", body, init);
}

export function updateProduct(
  idOrSlug: string,
  body: Partial<Product>,
  scope?: Scope,
  init?: RequestInit,
) {
  return apiPatch<Product>(scoped(idOrSlug, scope), body, init);
}

export function deleteProduct(
  idOrSlug: string,
  scope?: Scope,
  init?: RequestInit,
) {
  return apiDelete<{ deleted: boolean }>(scoped(idOrSlug, scope), init);
}

export function duplicateProduct(
  idOrSlug: string,
  body?: { siteId?: number; categoryId?: number },
  scope?: Scope,
  init?: RequestInit,
) {
  return apiPost<Product>(
    `/api/products/${encodeURIComponent(idOrSlug)}/duplicate${buildQuery(scope)}`,
    body ?? {},
    init,
  );
}
