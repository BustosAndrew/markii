import { apiGet, apiPost } from "./client";
import type { ThemeId } from "./types";

export type PreviewDraftProduct = {
  name: string;
  slug?: string;
  priceCents: number;
  /** ISO code from the source. Preview already accepts this; omitting it labels every price USD. */
  currency?: string;
  description?: string;
  categorySlug?: string;
  stock?: number;
  /** False → the source published no count. Not sent to preview; used in the draft list. */
  stockKnown?: boolean;
  images?: string[];
  /** Set when the product came from an import; the wizard commits it through `/api/import/commit`. */
  importTempId?: string;
};

export type PreviewDraftCategory = {
  name: string;
  slug?: string;
};

export type PreviewDraft = {
  site: {
    name: string;
    slug?: string;
    indexed?: boolean;
    themeId?: ThemeId;
  };
  categories: PreviewDraftCategory[];
  products: PreviewDraftProduct[];
};

export type SitemapNode = {
  title: string;
  path: string;
  children?: SitemapNode[];
};

export type PreviewResponse = {
  html: string;
  llmsTxt: string;
  agentMd: string;
  sitemap: { pages: SitemapNode[] };
  jsonLd?: unknown;
};

export function postPreview(draft: PreviewDraft, init?: RequestInit) {
  return apiPost<PreviewResponse>("/api/preview", draft, init);
}

export function getSitePreview(idOrSlug: string, init?: RequestInit) {
  return apiGet<PreviewResponse>(
    `/api/sites/${encodeURIComponent(idOrSlug)}/preview`,
    undefined,
    init,
  );
}

export function getTemplate(init?: RequestInit) {
  return apiGet<PreviewDraft>("/api/template", undefined, init);
}
