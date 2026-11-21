import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatPrice } from "@markii/renderer/format";
import { getStore, siteUrl, storeUrl } from "../../lib/markii";
import { StorePage } from "../../lib/page";

type Props = { searchParams: Promise<{ q?: string }> };

export const metadata: Metadata = { title: "Search", robots: { index: false } };

type Result = { name: string; slug: string; priceMinor: number; currency: string; stock: number; membersOnly: boolean };

/**
 * Search, answered by the store's own `/api/search` — the same ranked search
 * Markii's storefront and buying agents use, so all three agree.
 */
export default async function SearchRoute({ searchParams }: Props) {
  const store = await getStore();
  if (!store) notFound();
  const q = ((await searchParams).q ?? "").trim().slice(0, 200);
  let results: Result[] = [];
  if (q) {
    const res = await fetch(`${storeUrl()}/api/search?q=${encodeURIComponent(q)}&limit=50`, { next: { revalidate: 60 } });
    if (res.ok) results = ((await res.json()) as { results: Result[] }).results;
  }
  const base = siteUrl();
  return (
    <StorePage store={store}>
      <main className="sf-main">
        <header className="sf-hero">
          <h1 className="sf-title">{q ? `Results for “${q}”` : "Search"}</h1>
          <p className="sf-lede">
            {!q
              ? "Search by product name, description, or SKU."
              : results.length === 0
                ? "Nothing matched. Try a different word."
                : `${results.length} ${results.length === 1 ? "product" : "products"} found.`}
          </p>
        </header>
        {results.length > 0 ? (
          <ul className="sf-list" aria-label="Search results">
            {results.map((p) => (
              <li key={p.slug}>
                <a href={`${base}/p/${p.slug}`}>{p.name}</a>
                <span>
                  <strong className="sf-price">{formatPrice(p.priceMinor, p.currency)}</strong>
                  <span className="sf-muted">
                    {" "}
                    — {p.stock > 0 ? `${p.stock} in stock` : "out of stock"}
                    {p.membersOnly ? " — members only" : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </StorePage>
  );
}
