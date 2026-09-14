import type { Product } from "@/lib/db";
import type { SiteData } from "@/lib/storefront";
import type { SearchResult } from "./search";

/**
 * The JSON `GET /api/search` answers with. Pure, so the shape `agent.md`
 * documents can be asserted against what the route builds.
 *
 * Money is `priceMinor` + `currency`, never a formatted string: the formatter
 * the storefront pages use predates D31 and hardcodes two fraction digits, and
 * an agent handed "$12.00" for a JPY store would be handed a lie. Minor units
 * with the currency beside them are what every newer surface returns.
 *
 * `membersOnly` is said outright so an agent does not walk a gated product
 * into checkout and get refused there; the product page shows the same lock.
 */
export type SearchResultJson = {
  name: string;
  slug: string;
  url: string;
  sku: string | null;
  /** Plain text, tags stripped, at most 160 characters. Same rule as `llms.txt`. */
  description: string | null;
  priceMinor: number;
  currency: string;
  stock: number;
  inStock: boolean;
  category: { name: string; slug: string } | null;
  membersOnly: boolean;
};

export type SearchResponseJson = {
  query: string;
  limit: number;
  count: number;
  results: SearchResultJson[];
};

const strip = (s: string | null | undefined) =>
  (s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export function searchResultJson(data: SiteData, product: Product): SearchResultJson {
  const category =
    product.categoryId != null ? data.cats.find((c) => c.id === product.categoryId) : undefined;
  const description = strip(product.description).slice(0, 160);
  return {
    name: product.name,
    slug: product.slug,
    url: `${data.baseUrl}/p/${product.slug}`,
    sku: product.sku ?? null,
    description: description || null,
    priceMinor: product.priceCents,
    currency: product.currency,
    stock: product.stock,
    inStock: product.stock > 0,
    category: category && category.enabled ? { name: category.name, slug: category.slug } : null,
    membersOnly: product.requiresTierId != null,
  };
}

export function searchResultsJson(
  data: SiteData,
  query: string,
  limit: number,
  results: SearchResult[],
): SearchResponseJson {
  return {
    query,
    limit,
    count: results.length,
    results: results.map((r) => searchResultJson(data, r.product)),
  };
}
