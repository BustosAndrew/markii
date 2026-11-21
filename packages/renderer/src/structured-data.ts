import { decimalMinor } from "./money";
import { plainText } from "./views";

/**
 * A product's Schema.org `Product` JSON-LD — what buying agents read off a
 * product page. **One builder for Markii's product route and an exported
 * store's** (D53), so the structured data an agent finds cannot depend on who
 * is hosting the page. `lib/generators.ts` `productJsonLd` is this, typed.
 *
 * Route-level, never a block: no design can remove it.
 */
export function productStructuredData(
  product: {
    name: string;
    slug: string;
    description?: string | null;
    images: string[];
    sku?: string | null;
    /** The currency's own minor unit (D50). */
    priceCents: number;
    currency: string;
    stock: number;
  },
  storeName: string,
  baseUrl: string,
) {
  const url = `${baseUrl}/p/${product.slug}`;
  return {
    "@context": "https://schema.org" as const,
    "@type": "Product" as const,
    name: product.name,
    description: plainText(product.description) || undefined,
    image: product.images.length ? product.images : undefined,
    sku: product.sku ?? undefined,
    url,
    offers: {
      "@type": "Offer" as const,
      // The currency's own decimals, as the price is charged.
      price: decimalMinor(product.priceCents, product.currency),
      priceCurrency: product.currency,
      availability: product.stock > 0 ? ("https://schema.org/InStock" as const) : ("https://schema.org/OutOfStock" as const),
      url,
      seller: { "@type": "Organization" as const, name: storeName },
    },
  };
}

/**
 * A collection page's Schema.org `CollectionPage`, carrying an `ItemList` of
 * the products' URLs in the collection's order, so an agent reads the set
 * without crawling each card. Route-level, like the product's.
 */
export function collectionStructuredData(
  collection: { title: string; handle: string; description?: string | null },
  items: { name: string; slug: string }[],
  baseUrl: string,
) {
  return {
    "@context": "https://schema.org" as const,
    "@type": "CollectionPage" as const,
    name: collection.title,
    description: plainText(collection.description) || undefined,
    url: `${baseUrl}/collections/${collection.handle}`,
    mainEntity: {
      "@type": "ItemList" as const,
      numberOfItems: items.length,
      itemListElement: items.map((p, i) => ({
        "@type": "ListItem" as const,
        position: i + 1,
        url: `${baseUrl}/p/${p.slug}`,
        name: p.name,
      })),
    },
  };
}
