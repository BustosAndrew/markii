import { apiGet, apiPost } from "./client";

export type PreviewDraftProduct = {
  name: string;
  slug?: string;
  priceCents: number;
  description?: string;
  categorySlug?: string;
  stock?: number;
  images?: string[];
};

export type PreviewDraftCategory = {
  name: string;
  slug?: string;
};

export type PreviewDraft = {
  site: { name: string; slug?: string; indexed?: boolean };
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
