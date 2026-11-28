import type { BlogPost, Category, Collection, Product, SiteForm } from "@/lib/db";
import { descriptionOf, excerptOf } from "@/lib/blog/rules";
import type { ContentGate } from "@/lib/commerce/memberships";
import type { FormField } from "@markii/renderer/forms";
import type { ThemePackage } from "@markii/renderer/theme-package";
import type { SiteData } from "@/lib/storefront";

/**
 * The storefront read API (D53) — what a headless storefront, an exported
 * Next.js app above all, reads a store's catalogue and published design from.
 * `GET /api/store`, `/api/products`, `/api/products/{slug}` and
 * `/api/collections/{handle}`, `/api/forms/{handle}` and `/api/blog/posts[/{handle}]` on the
 * store's own host.
 *
 * **Nothing here is new information.** Every field is already public on the
 * store's own pages — the product page, the collection pages, the JSON-LD,
 * `llms.txt` — so the API widens no one's view of a store; it changes only the
 * shape. That is the test a field must pass to be added: a shopper standing on
 * the storefront can already see it. Cost price, stock ledgers, tax codes,
 * customer anything, and the merchant's **head code** fail it — head code never
 * travels in any package (D53), and the design here is a theme package.
 *
 * Pure, so the shapes are asserted against what the routes build.
 *
 * **Money is `priceMinor` + `currency`** (D31/D50), like every newer surface.
 * The renderer's own `RenderProduct` still names it `priceCents`; an export
 * maps one to the other in one place rather than this API inheriting the
 * legacy name.
 */

/** Plain-text summary, the rule `llms.txt` and `/api/search` use. */
const strip = (s: string | null | undefined) => (s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export type StorefrontCategoryJson = {
  id: number;
  parentId: number | null;
  name: string;
  slug: string;
  description: string | null;
};

export type StorefrontCollectionJson = {
  id: number;
  handle: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  url: string;
};

export type StorefrontProductJson = {
  id: number;
  slug: string;
  name: string;
  url: string;
  /** The merchant's description as stored — the renderer draws it, as on the product page. */
  description: string | null;
  /** Plain text, tags stripped, at most 160 characters. */
  summary: string | null;
  sku: string | null;
  priceMinor: number;
  currency: string;
  stock: number;
  inStock: boolean;
  images: string[];
  categoryId: number | null;
  /** Enabled ones only — a disabled product is not on the storefront to suggest. */
  suggestedProductIds: number[];
  /**
   * Gated to a membership tier (§18.9). Said outright so a headless store does
   * not walk a shopper into a checkout that refuses them. An exported store
   * unlocks one by calling the cart and checkout from its **server** with a
   * storefront secret key naming the shopper (`lib/auth/storefront-keys.ts`);
   * compare `requiresTierId` with the tiers `GET /api/account/memberships`
   * answers for that shopper.
   */
  membersOnly: boolean;
  requiresTierId: number | null;
};

export type StorefrontVariantJson = {
  id: number;
  title: string;
  optionValues: Record<string, string>;
  priceMinor: number;
  /** Sellable now, summed across locations — what the product page's picker shows. */
  available: number;
};

export type StorefrontProductDetailJson = StorefrontProductJson & {
  /** The tier's name, as the product page's lock shows it. Null when ungated, or the tier is gone. */
  requiresTier: { id: number; name: string } | null;
  options: { name: string; position: number; values: string[] }[];
  variants: StorefrontVariantJson[];
};

export type StorefrontStoreJson = {
  store: {
    name: string;
    slug: string;
    url: string;
    /**
     * The published theme (`sites.themeId`). With a published design this is
     * `design.theme.themeId` too; without one it is the only theme there is.
     */
    themeId: string;
    /** Whether the store publishes `llms.txt` / `agent.md` — the merchant's switch, already visible as those documents existing or not. */
    agentDiscovery: boolean;
    /** Whether the store takes orders at all right now — the merchant's switch. */
    purchasesEnabled: boolean;
    /** The rails checkout accepts (`POST /api/checkout/session` `rail`). */
    rails: { stripe: boolean; x402: boolean };
  };
  categories: StorefrontCategoryJson[];
  collections: StorefrontCollectionJson[];
  /**
   * The published design as a theme package, **without head code and without
   * saved blocks** (those are the editor's, not the store's). `null` when the
   * store has never published one: Markii then draws its fixed layout, and so
   * must the headless store.
   *
   * **Members-only pages (§18.9) arrive with an empty tree** — the tree is the
   * paid content and this answer is public. They are listed in
   * `membersOnlyPages`; fetch one's tree from `GET /api/pages/{handle}` on a
   * shopper's behalf.
   */
  design: ThemePackage | null;
  membersOnlyPages: { handle: string; requiresTierId: number }[];
};

export function categoryJson(c: Category): StorefrontCategoryJson {
  return { id: c.id, parentId: c.parentId ?? null, name: c.name, slug: c.slug, description: c.description ?? null };
}

export function collectionJson(data: Pick<SiteData, "baseUrl">, c: Collection): StorefrontCollectionJson {
  return {
    id: c.id,
    handle: c.handle,
    title: c.title,
    description: c.description ?? null,
    imageUrl: c.imageUrl ?? null,
    url: `${data.baseUrl}/collections/${c.handle}`,
  };
}

export function productJson(data: Pick<SiteData, "baseUrl" | "prods">, p: Product): StorefrontProductJson {
  const enabledIds = new Set(data.prods.filter((x) => x.enabled).map((x) => x.id));
  const summary = strip(p.description).slice(0, 160);
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    url: `${data.baseUrl}/p/${p.slug}`,
    description: p.description ?? null,
    summary: summary || null,
    sku: p.sku ?? null,
    priceMinor: p.priceCents,
    currency: p.currency,
    stock: p.stock,
    inStock: p.stock > 0,
    images: p.images ?? [],
    categoryId: p.categoryId ?? null,
    suggestedProductIds: (p.suggestedProductIds ?? []).filter((id) => enabledIds.has(id)),
    membersOnly: p.requiresTierId != null,
    requiresTierId: p.requiresTierId ?? null,
  };
}

/** Enabled categories only — the storefront's own navigation hides the rest. */
export function storeJson(
  data: SiteData,
  design: ThemePackage | null,
  membersOnlyPages: { handle: string; requiresTierId: number }[] = [],
): StorefrontStoreJson {
  const { site } = data;
  return {
    store: {
      name: site.name,
      slug: site.slug,
      url: data.baseUrl,
      themeId: site.themeId,
      agentDiscovery: site.agentDiscovery,
      purchasesEnabled: site.purchasesEnabled,
      rails: { stripe: Boolean(site.paymentProviders?.stripe), x402: Boolean(site.paymentProviders?.x402) },
    },
    categories: data.cats.filter((c) => c.enabled).map(categoryJson),
    collections: data.colls.map((c) => collectionJson(data, c)),
    design: design ? { ...design, savedBlocks: [] } : null,
    membersOnlyPages,
  };
}

/**
 * One published builder page (`GET /api/pages/{handle}`) — what its route
 * draws. `tree` is null and `locked` true on a members-only page the caller
 * may not read; its title and SEO are public, as on its own page.
 */
export type StorefrontPageJson = {
  handle: string;
  title: string;
  seo: { title?: string; description?: string; ogImage?: string; noindex?: boolean };
  url: string;
  membersOnly: boolean;
  requiresTierId: number | null;
  locked: boolean;
  gate: StorefrontGateJson | null;
  tree: unknown | null;
};

export function pageJson(
  data: Pick<SiteData, "baseUrl">,
  page: { handle: string; title: string; seo: StorefrontPageJson["seo"]; tree: unknown; requiresTierId: number | null },
  gate: ContentGate | null = null,
): StorefrontPageJson {
  const base = data.baseUrl.replace(/\/$/, "");
  const locked = page.requiresTierId != null && !gate?.unlocked;
  return {
    handle: page.handle,
    title: page.title,
    seo: page.seo,
    url: page.handle === "home" ? `${base}/` : `${base}/pages/${page.handle}`,
    membersOnly: page.requiresTierId != null,
    requiresTierId: page.requiresTierId,
    locked,
    gate: page.requiresTierId != null ? (gateJson(data, gate) ?? { tierName: null, join: [] }) : null,
    tree: locked ? null : page.tree,
  };
}

/**
 * A form as its page shows it — the fields, the button and the thank-you
 * message, all on `/forms/{handle}` already. **`notifyEmail` is not here**: where
 * a merchant's submissions are mailed is theirs, not a shopper's.
 */
export type StorefrontFormJson = {
  handle: string;
  name: string;
  fields: FormField[];
  submitLabel: string;
  successMessage: string;
  /** The form's own page on the store. */
  url: string;
  /** Where a submission is posted — `application/x-www-form-urlencoded` or JSON. */
  submitUrl: string;
};

export function formJson(data: Pick<SiteData, "baseUrl">, f: SiteForm): StorefrontFormJson {
  const base = data.baseUrl.replace(/\/$/, "");
  return {
    handle: f.handle,
    name: f.name,
    fields: f.fields,
    submitLabel: f.submitLabel,
    successMessage: f.successMessage,
    url: `${base}/forms/${f.handle}`,
    submitUrl: `${base}/api/forms/${f.handle}`,
  };
}

/**
 * A live post as `/blog` lists it. Live only — the read API never serves the
 * preview, so a draft or a scheduled post is not here until its time comes.
 */
export type StorefrontPostSummaryJson = {
  handle: string;
  title: string;
  excerpt: string;
  coverImage: string | null;
  coverAlt: string;
  author: string;
  publishedAt: string;
  updatedAt: string;
  url: string;
  /**
   * Members-only (§18.9). Listed like any post — title, merchant excerpt,
   * cover — with the body behind the gate. Compare `requiresTierId` with the
   * shopper's tiers, as for a members-only product.
   */
  membersOnly: boolean;
  requiresTierId: number | null;
};

/**
 * One post as `/blog/{handle}` shows it. `body` is the Markdown subset
 * `@markii/renderer/article` parses — `""` and `locked: true` on a members-only
 * post the caller may not read.
 */
export type StorefrontPostJson = StorefrontPostSummaryJson & {
  locked: boolean;
  /** On a members-only post: who it is for and what to buy to join, for the notice in its place. Null on a public one. */
  gate: StorefrontGateJson | null;
  body: string;
  /** The meta description: the post's SEO description, else its excerpt. */
  description: string;
  seo: { title?: string; description?: string; ogImage?: string; noindex?: boolean };
};

export function postSummaryJson(data: Pick<SiteData, "baseUrl">, p: BlogPost): StorefrontPostSummaryJson {
  const base = data.baseUrl.replace(/\/$/, "");
  return {
    handle: p.handle,
    title: p.title,
    excerpt: excerptOf(p),
    coverImage: p.coverImage,
    coverAlt: p.coverAlt,
    author: p.author,
    // Live posts only reach here, so the date is always set.
    publishedAt: (p.publishedAt ?? p.createdAt).toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    url: `${base}/blog/${p.handle}`,
    membersOnly: p.requiresTierId != null,
    requiresTierId: p.requiresTierId ?? null,
  };
}

/** A members-only page's or post's gate as the read API reports it (§18.9). */
export type StorefrontGateJson = {
  tierName: string | null;
  /** Products that grant the tier — where a "Join" link goes. */
  join: { name: string; slug: string; url: string }[];
};

function gateJson(data: Pick<SiteData, "baseUrl">, gate: ContentGate | null): StorefrontGateJson | null {
  if (!gate) return null;
  const base = data.baseUrl.replace(/\/$/, "");
  return { tierName: gate.tierName, join: gate.join.map((j) => ({ ...j, url: `${base}/p/${j.slug}` })) };
}

/**
 * `gate` is the caller's view of a members-only post (`contentGateFor`); the
 * body is sent only when it is unlocked. A members-only post with no gate given
 * is locked — the safe reading of a caller that forgot to ask.
 */
export function postJson(data: Pick<SiteData, "baseUrl">, p: BlogPost, gate: ContentGate | null = null): StorefrontPostJson {
  const { title, description, ogImage, noindex } = p.seo;
  const locked = p.requiresTierId != null && !gate?.unlocked;
  return {
    ...postSummaryJson(data, p),
    locked,
    gate: p.requiresTierId != null ? (gateJson(data, gate) ?? { tierName: null, join: [] }) : null,
    body: locked ? "" : p.body,
    description: descriptionOf(p),
    seo: { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(ogImage ? { ogImage } : {}), ...(noindex ? { noindex } : {}) },
  };
}

export const PRODUCT_PAGE_MAX = 250;
export const PRODUCT_PAGE_DEFAULT = 50;

/** `limit`/`offset` from a query string, clamped — a bad value is the default, never a 400. */
export function pageParams(sp: URLSearchParams): { limit: number; offset: number } {
  const limit = Number.parseInt(sp.get("limit") ?? "", 10);
  const offset = Number.parseInt(sp.get("offset") ?? "", 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, PRODUCT_PAGE_MAX) : PRODUCT_PAGE_DEFAULT,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

/**
 * Headers every read answers with. **Any origin may read, and none may send
 * credentials**: the data is public, and `Access-Control-Allow-Credentials` is
 * deliberately absent, so a browser never attaches a storefront session to a
 * cross-origin read and no response here can depend on one. Cached briefly —
 * an exported store should revalidate on its own schedule, not per visitor.
 */
export const READ_API_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=60",
} as const;
