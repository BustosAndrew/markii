import { apiDelete, apiGet, apiPatch, apiPost } from "./client";
import type { Category, Paginated } from "./types";

export type CategoriesQuery = {
  q?: string;
  siteId?: number;
  parentId?: number | null;
  enabled?: boolean;
  page?: number;
  limit?: number;
};

export function listCategories(query?: CategoriesQuery, init?: RequestInit) {
  return apiGet<Paginated<Category>>("/api/categories", query, init);
}

export function getCategory(
  idOrSlug: string,
  query?: { siteId?: number },
  init?: RequestInit,
) {
  return apiGet<Category>(
    `/api/categories/${encodeURIComponent(idOrSlug)}`,
    query,
    init,
  );
}

export function createCategory(
  body: Partial<Category> & { siteId: number; name: string },
  init?: RequestInit,
) {
  return apiPost<Category>("/api/categories", body, init);
}

export function updateCategory(
  idOrSlug: string,
  body: Partial<Category>,
  init?: RequestInit,
) {
  return apiPatch<Category>(
    `/api/categories/${encodeURIComponent(idOrSlug)}`,
    body,
    init,
  );
}

export function deleteCategory(idOrSlug: string, init?: RequestInit) {
  return apiDelete<{ deleted: boolean; id: number }>(
    `/api/categories/${encodeURIComponent(idOrSlug)}`,
    init,
  );
}

export function duplicateCategory(
  idOrSlug: string,
  body?: { siteId?: number; includeProducts?: boolean },
  init?: RequestInit,
) {
  return apiPost<Category>(
    `/api/categories/${encodeURIComponent(idOrSlug)}/duplicate`,
    body ?? {},
    init,
  );
}
