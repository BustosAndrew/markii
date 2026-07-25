import { apiDelete, apiGet, apiPatch, apiPost } from "./client";
import type { Paginated, Site, SiteStatus } from "./types";

export type SitesQuery = {
  q?: string;
  status?: SiteStatus;
  page?: number;
  limit?: number;
  sort?: "name" | "createdAt" | "-createdAt";
};

export function listSites(query?: SitesQuery, init?: RequestInit) {
  return apiGet<Paginated<Site>>("/api/sites", query, init);
}

export function getSite(idOrSlug: string, init?: RequestInit) {
  return apiGet<Site>(`/api/sites/${encodeURIComponent(idOrSlug)}`, undefined, init);
}

export function createSite(
  body: Partial<Site> & { name: string },
  init?: RequestInit,
) {
  return apiPost<Site>("/api/sites", body, init);
}

export function updateSite(
  idOrSlug: string,
  body: Partial<Site>,
  init?: RequestInit,
) {
  return apiPatch<Site>(
    `/api/sites/${encodeURIComponent(idOrSlug)}`,
    body,
    init,
  );
}

export function deleteSite(idOrSlug: string, init?: RequestInit) {
  return apiDelete<{ deleted: boolean; id: number }>(
    `/api/sites/${encodeURIComponent(idOrSlug)}`,
    init,
  );
}

export type SiteSummary = {
  traffic: {
    total: number;
    last7d: number;
    byDay: { date: string; count: number }[];
  };
  purchases: { count: number; last7d: number };
  balance: { totalCents: number; x402Cents: number; fiatCents: number };
};

export function getSiteSummary(idOrSlug: string, init?: RequestInit) {
  return apiGet<SiteSummary>(
    `/api/sites/${encodeURIComponent(idOrSlug)}/summary`,
    undefined,
    init,
  );
}

export function deploySite(idOrSlug: string, init?: RequestInit) {
  return apiPost<{ status: "live"; storefrontUrl: string }>(
    `/api/sites/${encodeURIComponent(idOrSlug)}/deploy`,
    undefined,
    init,
  );
}
