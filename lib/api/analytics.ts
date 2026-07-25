import { apiGet } from "./client";
import type { Paginated } from "./types";

export type AnalyticsOverview = {
  total: number;
  byDay: { date: string; count: number }[];
  byAgent: { agentName: string; count: number }[];
  sites: {
    siteId: number;
    siteName: string;
    siteSlug: string;
    total: number;
    last7d: number;
    /** null when the site has no traffic in range */
    topAgent: string | null;
  }[];
};

export type AnalyticsProductRow = {
  productId: number;
  name: string;
  slug: string;
  views: number;
  agents: { agentName: string; views: number }[];
};

export type AnalyticsSiteDetail = {
  site: { id: number; name: string; slug: string };
  total: number;
  byDay: { date: string; count: number }[];
  byAgent: { agentName: string; count: number }[];
  products: Paginated<AnalyticsProductRow>;
};

export type AnalyticsQuery = {
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
};

export function getAnalyticsOverview(
  query?: Pick<AnalyticsQuery, "q" | "from" | "to">,
  init?: RequestInit,
) {
  return apiGet<AnalyticsOverview>("/api/analytics/overview", query, init);
}

export function getSiteAnalytics(
  idOrSlug: string,
  query?: AnalyticsQuery,
  init?: RequestInit,
) {
  return apiGet<AnalyticsSiteDetail>(
    `/api/analytics/sites/${encodeURIComponent(idOrSlug)}`,
    query,
    init,
  );
}
