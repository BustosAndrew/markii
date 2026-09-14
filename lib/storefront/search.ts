import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db, products, type Product } from "@/lib/db";

/**
 * Storefront product search (G6).
 *
 * Postgres full-text search over `products.search_vector`, ranked, with a
 * substring fallback — and no search vendor, because a per-store catalogue is
 * small enough that the database it already lives in is sufficient. Revisit
 * only if relevance complaints appear at scale.
 *
 * This is the retrieval path `agent.md` advertises: a buyer agent that wants
 * "a blue hoodie under $60" can ask for it instead of crawling every product
 * page. It answers the same catalogue the pages show — enabled products only,
 * gated ones included (the product page renders those with a lock, so listing
 * them is consistent, and hiding them would make a member's search miss the
 * things they pay to see).
 */

/** Longest query accepted. Anything beyond this is a paste, not a search. */
export const MAX_QUERY_LENGTH = 200;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/**
 * Trims, collapses whitespace, and caps length. Returns `""` for anything that
 * has nothing to search for, which every caller treats as "show the form", not
 * as "search for nothing".
 */
export function normalizeQuery(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/** Clamps a requested page size into `[1, MAX_LIMIT]`, defaulting when absent or unparsable. */
export function clampLimit(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

/**
 * Escapes a search term for use inside an `ILIKE '%…%'` pattern. `%` and `_`
 * are wildcards there, and a shopper typing "100%" should match "100%" — not
 * every product.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type SearchResult = {
  product: Product;
  /** `ts_rank_cd` of the full-text match; 0 when only the substring fallback matched. */
  rank: number;
};

/**
 * Enabled products on one site matching `query`, best first.
 *
 * Two matchers are combined in one query rather than run in sequence:
 *
 * - **Full-text** (`@@ websearch_to_tsquery`) is what ranks. `websearch_`
 *   rather than `plainto_` because it accepts what people actually type —
 *   quoted phrases, `-excluded` words, `or` — and never throws on unbalanced
 *   input, so a stray quote is a search and not a 500.
 * - **Substring** on name and SKU catches what the stemmer cannot: a partial
 *   word mid-typing, a SKU fragment, a word in a language the `english`
 *   dictionary does not know. These rank at 0 and sort by name after every
 *   full-text hit.
 *
 * The site filter comes first in the predicate on purpose: the GIN index is
 * global, and a store's search must never be answered from another store's
 * catalogue. `enabled` matches what every storefront page lists.
 */
export async function searchProducts(
  siteId: number,
  query: string,
  limit = DEFAULT_LIMIT,
): Promise<SearchResult[]> {
  const q = normalizeQuery(query);
  if (!q) return [];

  const tsquery = sql`websearch_to_tsquery('english', ${q})`;
  const rank = sql<number>`ts_rank_cd(${products.searchVector}, ${tsquery})`;
  const pattern = likePattern(q);

  const rows = await db
    .select({ product: products, rank })
    .from(products)
    .where(
      and(
        eq(products.siteId, siteId),
        eq(products.enabled, true),
        or(
          sql`${products.searchVector} @@ ${tsquery}`,
          ilike(products.name, pattern),
          ilike(products.sku, pattern),
        ),
      ),
    )
    .orderBy(desc(rank), asc(products.name), asc(products.id))
    .limit(clampLimit(limit));

  return rows.map((r) => ({ product: r.product, rank: Number(r.rank) }));
}
