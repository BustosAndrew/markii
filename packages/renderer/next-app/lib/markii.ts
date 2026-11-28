import "server-only";
import { cache } from "react";
import type { RenderCategory, RenderCollection, RenderPost, RenderProduct } from "@markii/renderer/catalog";
import type { FormField } from "@markii/renderer/forms";
import type { ThemePackage } from "@markii/renderer/theme-package";
import { currentShopperEmail } from "./shopper";

/**
 * This store's data, read from its Markii storefront API (`docs/API.md` §23 in
 * the Markii repository). Catalogue and design are public reads, cached for a
 * minute; anything about a particular shopper is sent from this server with
 * your storefront key and never cached.
 *
 * Environment (see `.env.example`):
 * - `MARKII_STORE_URL` — the store on Markii, e.g. `https://leaf.markii.shop`. Required.
 * - `SITE_URL` — where this app is served, e.g. `https://shop.example.com`. Links and
 *   structured data use it; without it links are relative and JSON-LD URLs are not absolute.
 * - `MARKII_STOREFRONT_KEY` — the store's secret key (`mksk_live_…`), for members-only
 *   products. **Server only — never expose it to the browser.**
 */

const REVALIDATE_SECONDS = 60;

export function storeUrl(): string {
  const url = process.env.MARKII_STORE_URL;
  if (!url) throw new Error("MARKII_STORE_URL is not set — see .env.example");
  return url.replace(/\/$/, "");
}

export function siteUrl(): string {
  return (process.env.SITE_URL ?? "").replace(/\/$/, "");
}

export type StoreJson = {
  store: {
    name: string;
    slug: string;
    url: string;
    themeId: string;
    agentDiscovery: boolean;
    purchasesEnabled: boolean;
    rails: { stripe: boolean; x402: boolean };
  };
  categories: RenderCategory[];
  collections: (RenderCollection & { url: string })[];
  /** The published design, or null when the store has never published one. */
  design: ThemePackage | null;
  /**
   * Members-only pages. Their tree in `design` is empty — the content is the
   * members' — and `getPage` fetches it for a shopper who holds the tier.
   */
  membersOnlyPages: { handle: string; requiresTierId: number }[];
};

type ProductJson = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  sku: string | null;
  priceMinor: number;
  currency: string;
  stock: number;
  images: string[];
  categoryId: number | null;
  suggestedProductIds: number[];
  membersOnly: boolean;
  requiresTierId: number | null;
};

export type ProductDetailJson = ProductJson & {
  requiresTier: { id: number; name: string } | null;
  options: { name: string; position: number; values: string[] }[];
  variants: { id: number; title: string; optionValues: Record<string, string>; priceMinor: number; available: number }[];
};

/** The API's product as the renderer draws it — the one place the two shapes meet. */
export function toRenderProduct(p: ProductJson): RenderProduct {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    enabled: true,
    categoryId: p.categoryId,
    description: p.description,
    priceCents: p.priceMinor,
    currency: p.currency,
    sku: p.sku,
    stock: p.stock,
    images: p.images,
    suggestedProductIds: p.suggestedProductIds,
  };
}

async function read<T>(path: string): Promise<T | null> {
  const res = await fetch(`${storeUrl()}${path}`, { next: { revalidate: REVALIDATE_SECONDS } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Markii answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** The store, or null when Markii says it is unavailable (paused, or not found). */
export const getStore = cache(() => read<StoreJson>("/api/store"));

/** Every enabled product, paged through. */
export const getProducts = cache(async (): Promise<RenderProduct[]> => {
  const out: RenderProduct[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: { products: ProductJson[]; next: number | null } | null = await read(`/api/products?limit=250&offset=${offset}`);
    if (!page) break;
    out.push(...page.products.map(toRenderProduct));
    offset = page.next;
  }
  return out;
});

export const getProduct = cache((slug: string) => read<ProductDetailJson>(`/api/products/${encodeURIComponent(slug)}`));

export const getCollectionProducts = cache(async (handle: string, limit: number): Promise<RenderProduct[]> => {
  const res = await read<{ products: ProductJson[] }>(`/api/collections/${encodeURIComponent(handle)}?limit=${limit}`);
  return res ? res.products.map(toRenderProduct) : [];
});

/** A store form as Markii serves it (`GET /api/forms/{handle}`) — what a `form` block and `/forms/{handle}` draw. */
export type FormJson = {
  handle: string;
  name: string;
  fields: FormField[];
  submitLabel: string;
  successMessage: string;
  url: string;
  submitUrl: string;
};

export const getForm = cache((handle: string) => read<FormJson>(`/api/forms/${encodeURIComponent(handle)}`));

/** A live post as Markii lists it (`GET /api/blog/posts`). Drafts and scheduled posts are never served. */
export type PostSummaryJson = {
  handle: string;
  title: string;
  excerpt: string;
  coverImage: string | null;
  coverAlt: string;
  author: string;
  publishedAt: string;
  updatedAt: string;
  url: string;
  /** Members-only: listed with its title and excerpt; the body is for the tier's members. */
  membersOnly: boolean;
  requiresTierId: number | null;
};

/** Who a members-only page or post is for, and the products that grant it. */
export type GateJson = { tierName: string | null; join: { name: string; slug: string; url: string }[] };

/**
 * One post (`GET /api/blog/posts/{handle}`). `body` is the Markdown subset
 * `@markii/renderer/article` draws — empty, with `locked: true`, on a
 * members-only post this shopper may not read.
 */
export type PostJson = PostSummaryJson & {
  locked: boolean;
  gate: GateJson | null;
  body: string;
  description: string;
  seo: { title?: string; description?: string; ogImage?: string; noindex?: boolean };
};

export type PostPage = { posts: PostSummaryJson[]; page: number; pages: number; total: number };

/** A page of the store's live posts, newest first. Null when the store is unavailable. */
export const getPosts = cache((page: number, limit = 20) => read<PostPage>(`/api/blog/posts?page=${page}&limit=${limit}`));

/**
 * One post. A public post is a cached read like the catalogue. A members-only
 * one is asked for again **as the shopper** (your storefront key and their
 * verified email), never cached, because Markii sends its body only to a
 * member — and what one shopper may read must not be cached for the next.
 */
export const getPost = cache(async (handle: string): Promise<PostJson | null> => {
  const path = `/api/blog/posts/${encodeURIComponent(handle)}`;
  const post = await read<PostJson>(path);
  if (!post?.membersOnly) return post;
  return (await readAsShopper<PostJson>(path)) ?? post;
});

/** A published page (`GET /api/pages/{handle}`): its tree, or `locked` with none for a members-only page this shopper may not read. */
export type PageJson = {
  handle: string;
  title: string;
  seo: { title?: string; description?: string; ogImage?: string; noindex?: boolean };
  url: string;
  membersOnly: boolean;
  requiresTierId: number | null;
  locked: boolean;
  gate: GateJson | null;
  tree: unknown | null;
};

/** A members-only page, asked for as the shopper — never cached, for the reason on `getPost`. */
export const getPage = cache((handle: string) => readAsShopper<PageJson>(`/api/pages/${encodeURIComponent(handle)}`));

async function readAsShopper<T>(path: string): Promise<T | null> {
  const res = await asShopper(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Markii answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** The API's post as the renderer lists it. */
export function toRenderPost(p: PostSummaryJson): RenderPost {
  return {
    handle: p.handle,
    title: p.title,
    excerpt: p.excerpt,
    coverImage: p.coverImage,
    coverAlt: p.coverAlt,
    author: p.author,
    publishedAt: p.publishedAt,
    membersOnly: p.membersOnly,
  };
}

/**
 * A call to the store **as the signed-in shopper**: your storefront key plus
 * the email your sign-in verified. From this server only — Markii refuses a
 * key that arrives from a browser. Without a shopper or a key it is a guest call.
 */
export async function asShopper(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = process.env.MARKII_STOREFRONT_KEY;
  const email = await currentShopperEmail();
  if (key) headers.authorization = `Bearer ${key}`;
  if (key && email) headers["markii-shopper-email"] = email;
  return fetch(`${storeUrl()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
}

/** The membership tiers the signed-in shopper holds now, or none. */
export const memberTierIds = cache(async (): Promise<Set<number>> => {
  if (!process.env.MARKII_STOREFRONT_KEY || !(await currentShopperEmail())) return new Set();
  const res = await asShopper("/api/account/memberships");
  if (!res.ok) return new Set();
  const body = (await res.json()) as { memberships: { tier: { id: number }; status: string }[] };
  return new Set(body.memberships.filter((m) => m.status === "active").map((m) => m.tier.id));
});
