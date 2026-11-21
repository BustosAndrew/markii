/**
 * The catalogue as the renderer reads it (D53) — exactly the fields drawing a
 * page needs, and nothing tying it to where they came from.
 *
 * These are the renderer's own shapes, not database rows, so the drawing code
 * can leave this app as its own package: Markii passes its rows (which have
 * these fields and more, so they fit as they are), and an exported storefront
 * passes what the store's storefront API returns. **Add a field here only when
 * a block draws it** — every field is one more thing an export must supply.
 */

export type RenderProduct = {
  id: number;
  name: string;
  slug: string;
  enabled: boolean;
  categoryId: number | null;
  description: string | null;
  /** The currency's own minor unit (D50), despite the name. */
  priceCents: number;
  currency: string;
  sku: string | null;
  stock: number;
  images: string[];
  suggestedProductIds: number[];
};

export type RenderCategory = {
  id: number;
  parentId: number | null;
  name: string;
  slug: string;
  description: string | null;
};

/** Published collections only — the caller filters. */
export type RenderCollection = {
  id: number;
  handle: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
};

/**
 * A collection's products, in the merchant's order — rules evaluated, enabled
 * only. The one catalogue lookup a page can need that is not in the lists it
 * was handed, so it is a function the caller supplies: Markii queries its
 * database, an export calls the storefront API. **By handle, not by row**, so
 * neither side's record type leaks into the other's — the renderer only ever
 * asks for a collection it found in the `collections` list it was given.
 */
export type MembersOf = (handle: string, limit: number) => Promise<RenderProduct[]>;
