import type { Category, Collection, Product, Site } from "@/lib/db";
import { formatPrice } from "@/lib/generators";
import type { CollectionView, ProductView, StoreView } from "./bindings";

/**
 * Catalogue rows as bindings see them (`./bindings`, M4): formatted for
 * display, plain text only. The storefront routes and the renderer's
 * repeaters build every view here, so a product reads the same in a template,
 * in a repeater, and in the preview.
 */

/** Imported descriptions can be HTML; a binding carries text, never markup. */
export function plainText(html: string | null | undefined): string {
  return (html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function trimBase(baseUrl: string) {
  return baseUrl.replace(/\/$/, "");
}

export function productView(
  p: Product,
  ctx: { baseUrl: string; categories: Category[]; products: Product[] },
): ProductView {
  const category = p.categoryId != null ? ctx.categories.find((c) => c.id === p.categoryId) : undefined;
  const enabled = new Set(ctx.products.filter((x) => x.enabled).map((x) => x.id));
  return {
    slug: p.slug,
    title: p.name,
    description: plainText(p.description),
    price: formatPrice(p.priceCents, p.currency),
    priceMinor: p.priceCents,
    image: p.images[0] ?? "",
    url: `${trimBase(ctx.baseUrl)}/p/${p.slug}`,
    sku: p.sku ?? "",
    stock: p.stock,
    inStock: p.stock > 0,
    stockStatus: p.stock > 0 ? `${p.stock} in stock` : "Out of stock",
    category: category?.name ?? "",
    relatedCount: p.suggestedProductIds.filter((id) => enabled.has(id)).length,
  };
}

export function collectionView(c: Collection, ctx: { baseUrl: string; productCount: number }): CollectionView {
  return {
    handle: c.handle,
    title: c.title,
    description: plainText(c.description),
    image: c.imageUrl ?? "",
    url: `${trimBase(ctx.baseUrl)}/collections/${c.handle}`,
    productCount: ctx.productCount,
  };
}

export function storeView(site: Pick<Site, "name">, ctx: { baseUrl: string; products: Product[]; collections: Collection[] }, now = new Date()): StoreView {
  return {
    name: site.name,
    url: `${trimBase(ctx.baseUrl)}/`,
    copyright: `© ${now.getUTCFullYear()} ${site.name}`,
    hasCollections: ctx.collections.length > 0,
    productCount: ctx.products.filter((p) => p.enabled).length,
  };
}

/** A product's related products, enabled only, in the merchant's order. */
export function relatedProducts(p: Product, products: Product[]): Product[] {
  const byId = new Map(products.filter((x) => x.enabled).map((x) => [x.id, x]));
  return p.suggestedProductIds.map((id) => byId.get(id)).filter((x): x is Product => Boolean(x));
}
