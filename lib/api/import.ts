import { apiFetch, apiPost } from "./client";
import type { Category, Product } from "./types";

export type ImportedItem = {
  tempId: string;
  name: string;
  slug?: string;
  priceCents: number;
  currency?: string;
  sku?: string | null;
  stock?: number;
  description?: string | null;
  images?: string[];
  categoryName?: string | null;
};

export type ImportedCategory = {
  tempId: string;
  name: string;
};

export type ImportParseResult = {
  source: string;
  imported: ImportedItem[];
  categories: ImportedCategory[];
  failed: { row?: number; reason: string }[];
};

export type ImportAllocation = {
  tempId: string;
  siteId: number;
  categoryTempId?: string;
  parentCategoryId?: number;
};

export type ImportCommitResult = {
  createdProducts: Product[];
  createdCategories: Category[];
  failed: { tempId: string; reason: string }[];
};

export function importFromUrl(url: string, init?: RequestInit) {
  return apiPost<ImportParseResult>("/api/import", { url }, init);
}

export async function importFromCsv(file: File, init?: RequestInit) {
  const form = new FormData();
  form.append("file", file);
  return apiFetch<ImportParseResult>("/api/import", {
    ...init,
    method: "POST",
    body: form,
  });
}

export function commitImport(
  body: {
    items: ImportedItem[];
    categories: ImportedCategory[];
    allocations: ImportAllocation[];
  },
  init?: RequestInit,
) {
  return apiPost<ImportCommitResult>("/api/import/commit", body, init);
}
