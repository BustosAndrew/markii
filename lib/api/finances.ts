import { apiGet, buildQuery } from "./client";
import type { Order, Paginated } from "./types";

export type FinancesOverview = {
  totalBalanceCents: number;
  x402BalanceCents: number;
  fiatBalanceCents: number;
  orderCount: number;
  sites: {
    siteId: number;
    siteName: string;
    siteSlug: string;
    balanceCents: number;
    x402Cents: number;
    fiatCents: number;
    orderCount: number;
    pendingCount: number;
  }[];
};

export type FinancesSiteDetail = {
  site: { id: number; name: string; slug: string };
  balance: { totalCents: number; x402Cents: number; fiatCents: number };
  transactions: Paginated<Order>;
};

export type FinancesQuery = {
  q?: string;
  from?: string;
  to?: string;
  status?: Order["status"];
  page?: number;
  limit?: number;
};

export function getFinancesOverview(
  query?: Pick<FinancesQuery, "q" | "from" | "to">,
  init?: RequestInit,
) {
  return apiGet<FinancesOverview>("/api/finances/overview", query, init);
}

export function getSiteFinances(
  idOrSlug: string,
  query?: FinancesQuery,
  init?: RequestInit,
) {
  return apiGet<FinancesSiteDetail>(
    `/api/finances/sites/${encodeURIComponent(idOrSlug)}`,
    query,
    init,
  );
}

export function siteFinancesExportUrl(
  idOrSlug: string,
  query?: Omit<FinancesQuery, "page" | "limit">,
) {
  return `/api/finances/sites/${encodeURIComponent(idOrSlug)}/export${buildQuery(query)}`;
}

/** `getOrder` lives in ./orders — the detail response is far more than an `Order`. */
