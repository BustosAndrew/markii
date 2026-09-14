import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { CollectionPage as SchemaCollectionPage, WithContext } from "schema-dts";
import { ProductCard } from "@/components/storefront/product-card";
import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { publishedCollectionByHandle, storefrontMembersOf } from "@/lib/storefront/collections";

type Props = { params: Promise<{ site: string; handle: string }> };

/**
 * `/collections/{handle}` — one published collection (§18.2), rendered as the
 * same product cards the home page uses, with a Schema.org `CollectionPage`
 * carrying an `ItemList` of the product URLs so an agent can read the set
 * without visiting each card.
 *
 * Membership is resolved **per request** — an automated collection is its
 * rules evaluated now, so "Under $20" cannot show a product that went to $30
 * this morning. An unpublished handle answers 404, exactly like one that never
 * existed: the merchant's publish switch must not leak what it is holding.
 */

function strip(html: string | null | undefined) {
  return (html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  const collection = data?.colls.find((c) => c.handle === handle);
  if (!data || !collection) return {};
  return {
    title: `${collection.title} — ${data.site.name}`,
    description: strip(collection.description).slice(0, 160) || undefined,
    robots: data.site.indexed ? undefined : { index: false },
  };
}

export default async function CollectionPage({ params }: Props) {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data || storefrontHalted(data)) notFound();
  const { site, bundle, colls, baseUrl } = data;

  const collection = await publishedCollectionByHandle(site.id, handle);
  if (!collection) notFound();

  await logTraffic({
    siteId: site.id,
    path: `/collections/${handle}`,
    userAgent: (await headers()).get("user-agent"),
  });

  const items = await storefrontMembersOf(collection);
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);
  const themeId = site.themeId ?? "studio";
  const description = strip(collection.description);

  const jsonLd: WithContext<SchemaCollectionPage> = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: collection.title,
    description: description || undefined,
    url: `${baseUrl}/collections/${collection.handle}`,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: items.length,
      itemListElement: items.map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${baseUrl}/p/${p.slug}`,
        name: p.name,
      })),
    },
  };

  return (
    <ThemeRoot themeId={themeId}>
      <script
        type="application/ld+json"
        // Trusted: built from the merchant's own catalog by this route.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        accountHref={`${baseUrl}/account`}
        searchAction={`${baseUrl}/search`}
        collectionsHref={colls.length > 0 ? `${baseUrl}/collections` : undefined}
        nav={topCategories.map((c) => ({ name: c.name, href: `${baseUrl}/c/${c.slug}` }))}
      />
      <main className="sf-main">
        <p className="sf-crumb">
          <a href={`${baseUrl}/`}>{site.name}</a> /{" "}
          <a href={`${baseUrl}/collections`}>Collections</a> / {collection.title}
        </p>
        <header className="sf-hero">
          <h1 className="sf-title">{collection.title}</h1>
          {description ? <p className="sf-lede">{description}</p> : null}
          {items.length === 0 ? <p className="sf-lede">Nothing in this collection right now.</p> : null}
        </header>
        {items.length > 0 ? (
          <ul className="sf-grid" aria-label={collection.title}>
            {items.map((p) => (
              <ProductCard
                key={p.id}
                name={p.name}
                href={`${baseUrl}/p/${p.slug}`}
                priceCents={p.priceCents}
                currency={p.currency}
                stock={p.stock}
                imageUrl={p.images[0]}
              />
            ))}
          </ul>
        ) : null}
      </main>
    </ThemeRoot>
  );
}
