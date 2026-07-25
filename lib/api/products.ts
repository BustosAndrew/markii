import { apiDelete, apiGet, apiPatch, apiPost } from "./client";
import type { Paginated, Product } from "./types";

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
  init?: RequestInit,
) {
  return apiPatch<Product>(
    `/api/products/${encodeURIComponent(idOrSlug)}`,
    body,
    init,
  );
}

export function deleteProduct(idOrSlug: string, init?: RequestInit) {
  return apiDelete<{ deleted: boolean }>(
    `/api/products/${encodeURIComponent(idOrSlug)}`,
    init,
  );
}

export function duplicateProduct(
  idOrSlug: string,
  body?: { siteId?: number; categoryId?: number },
  init?: RequestInit,
) {
  return apiPost<Product>(
    `/api/products/${encodeURIComponent(idOrSlug)}/duplicate`,
    body ?? {},
    init,
  );
}
