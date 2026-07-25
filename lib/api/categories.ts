import { apiDelete, apiGet, apiPatch, apiPost, buildQuery } from "./client";
import type { Category, Paginated } from "./types";

/**
 * Category slugs are unique per site, not globally — every by-slug call must carry
 * siteId or the API may resolve a same-slug category on a different site.
 */
type Scope = { siteId?: number };
const scoped = (idOrSlug: string, scope?: Scope) =>
  `/api/categories/${encodeURIComponent(idOrSlug)}${buildQuery(scope)}`;

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
  scope?: Scope,
  init?: RequestInit,
) {
  return apiPatch<Category>(scoped(idOrSlug, scope), body, init);
}

export function deleteCategory(
  idOrSlug: string,
  scope?: Scope,
  init?: RequestInit,
) {
  return apiDelete<{ deleted: boolean; id: number }>(scoped(idOrSlug, scope), init);
}

export function duplicateCategory(
  idOrSlug: string,
  body?: { siteId?: number; includeProducts?: boolean },
  scope?: Scope,
  init?: RequestInit,
) {
  return apiPost<Category>(
    `/api/categories/${encodeURIComponent(idOrSlug)}/duplicate${buildQuery(scope)}`,
    body ?? {},
    init,
  );
}
