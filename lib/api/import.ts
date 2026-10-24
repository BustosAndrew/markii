import { apiFetch, apiPost } from "./client";
import type { Category, Product } from "./types";

export type ImportedVariant = {
  title: string;
  /** Option name → value, matching the item's `options`. */
  optionValues: Record<string, string>;
  priceCents: number;
  compareAtCents: number | null;
  sku: string | null;
};

/**
 * A staged product (§5). **Send it back to `commitImport` unchanged** apart
 * from fields the merchant edited — `options`/`variants` only reach the
 * database through the commit route, and re-creating products by hand with
 * `createProduct` loses currency, SKU and every variant.
 */
export type ImportedItem = {
  tempId: string;
  name: string;
  slug?: string;
  /** Two-decimal minor units. Only two-decimal currencies are ever staged. */
  priceCents: number;
  currency?: string;
  sku?: string | null;
  stock?: number;
  /** False → the source published no count and `stock` is a placeholder 0. Show it. */
  stockKnown?: boolean;
  /** Plain text — the server converts source HTML. */
  description?: string | null;
  images?: string[];
  categoryName?: string | null;
  options?: { name: string; values: string[] }[];
  variants?: ImportedVariant[];
  /** Provenance — pass through untouched. Stored on the product as `importSource` etc. */
  source?: "csv" | "shopify" | "woocommerce" | "scrape";
  sourceId?: string | null;
  sourceUrl?: string | null;
};

export type ImportWarning = {
  code:
    | "STOCK_UNKNOWN"
    | "TRUNCATED"
    | "VARIANTS_NOT_IMPORTED"
    | "IMAGES_TRUNCATED"
    | "CURRENCY_ASSUMED"
    | "EXTRA_VARIANTS";
  /** Merchant-facing copy. Render verbatim. */
  message: string;
  tempIds?: string[];
};

export type ImportedCategory = {
  tempId: string;
  name: string;
};

export type ImportFailure = { row?: number; url?: string; name?: string; reason: string };

export type ImportParseResult = {
  source: string;
  imported: ImportedItem[];
  categories: ImportedCategory[];
  /** What could not be staged — a row number for CSV, a product name for a store. */
  failed: ImportFailure[];
  /** The import worked, but the merchant should know these before committing. */
  warnings: ImportWarning[];
};

export type ImportAllocation = {
  tempId: string;
  siteId: number;
  categoryTempId?: string;
  /** An existing category on `siteId` — e.g. one the wizard just created. */
  categoryId?: number;
  parentCategoryId?: number;
};

export type ImportCommitResult = {
  createdProducts: Product[];
  createdCategories: Category[];
  /** Includes "the product was created, but its variants were not" — not only skips. */
  failed: { tempId: string; reason: string }[];
  /** `EXTRA_VARIANTS`: grid combinations the source never sold, created out of stock. */
  warnings: ImportWarning[];
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
