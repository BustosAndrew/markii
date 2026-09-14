import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { formatPrice } from "@/lib/generators";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { normalizeQuery, searchProducts } from "@/lib/storefront/search";

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
};

/**
 * `/search?q=…` on a storefront (G6) — the human face of the same query
 * `GET /api/search` answers for agents.
 *
 * Server-rendered, no island: a `<form method="get">` is the whole interaction,
 * which is exactly the kind of page storefronts are meant to be. Results are
 * the same `sf-list` the category page renders, so a search result and a
 * category listing read identically to a shopper and to a crawler.
 */

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const data = await loadSite((await params).site);
  if (!data) return {};
  const q = normalizeQuery(firstParam((await searchParams).q));
  return {
    title: q ? `“${q}” — ${data.site.name}` : `Search — ${data.site.name}`,
    /**
     * Never indexed, whatever the site's own setting: a search page is a
     * query, not content, and letting crawlers index every `?q=` is how a store
     * ends up with ten thousand thin pages in a search engine.
     */
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({ params, searchParams }: Props) {
  const data = await loadSite((await params).site);
  if (!data || storefrontHalted(data)) notFound();
  const { site, bundle, baseUrl } = data;
  const q = normalizeQuery(firstParam((await searchParams).q));

  await logTraffic({
    siteId: site.id,
    path: "/search",
    userAgent: (await headers()).get("user-agent"),
  });

  const results = q ? await searchProducts(site.id, q) : [];
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);
  const themeId = site.themeId ?? "studio";

  return (
    <ThemeRoot themeId={themeId}>
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        accountHref={`${baseUrl}/account`}
        searchAction={`${baseUrl}/search`}
        searchQuery={q}
        nav={topCategories.map((c) => ({
          name: c.name,
          href: `${baseUrl}/c/${c.slug}`,
        }))}
      />
      <main className="sf-main">
        <p className="sf-crumb">
          <a href={`${baseUrl}/`}>{site.name}</a> / Search
        </p>
        <header className="sf-hero">
          <h1 className="sf-title">{q ? `Results for “${q}”` : "Search"}</h1>
          <p className="sf-lede">
            {!q
              ? "Search by product name, description, or SKU."
              : results.length === 0
                ? "Nothing matched. Try a different word, or browse the categories above."
                : `${results.length} ${results.length === 1 ? "product" : "products"} found.`}
          </p>
        </header>
        {results.length > 0 ? (
          <ul className="sf-list" aria-label="Search results">
            {results.map(({ product: p }) => (
              <li key={p.id}>
                <a href={`${baseUrl}/p/${p.slug}`}>{p.name}</a>
                <span>
                  <strong className="sf-price">{formatPrice(p.priceCents, p.currency)}</strong>
                  <span className="sf-muted">
                    {" "}
                    — {p.stock > 0 ? `${p.stock} in stock` : "out of stock"}
                    {p.requiresTierId != null ? " — members only" : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </ThemeRoot>
  );
}
