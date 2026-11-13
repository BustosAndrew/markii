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

/**
 * A storefront's address as a merchant reads it — `demo.markii.shop`, or
 * their verified custom domain. Pass `site.storefrontUrl`, never a hostname
 * built from the slug: the server's URL is the one shoppers and agents are
 * sent to (a verified domain wins, a pending one never does), and a literal
 * root domain here once showed every store at an address it did not have.
 */
export function storefrontAddress(storefrontUrl: string): string {
  return storefrontUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Stands in for the slug in an address built before the site exists (the
 * new-website wizard). Here, not in the wizard: a constant exported from a
 * `"use client"` module reaches a server component as a reference, not a string.
 */
export const SLUG_MARK = "__slug__";

/**
 * What these routes will actually write.
 *
 * `customDomain` and `walletAddress` are **refused by name**, not ignored: both
 * need something a field assignment cannot express — proof of domain ownership,
 * and a fresh MFA factor for a payout destination. Sending either is a `400`.
 * They are excluded here so that is a type error rather than a runtime surprise.
 *
 * Use `lib/api/domains.ts` for the domain, `payments.connectRail` for the wallet.
 */
export type SiteWritable = Partial<
  Omit<
    Site,
    | "id"
    | "customDomain"
    | "domainStatus"
    | "domainVerifiedAt"
    | "domainCheckedAt"
    | "domainLastError"
    | "walletAddress"
    | "productCount"
    | "categoryCount"
    | "storefrontUrl"
    | "createdAt"
    | "updatedAt"
  >
>;

export function createSite(body: SiteWritable & { name: string }, init?: RequestInit) {
  return apiPost<Site>("/api/sites", body, init);
}

export function updateSite(
  idOrSlug: string,
  body: SiteWritable,
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

/**
 * Publish a storefront, and attach `{slug}.{ROOT_DOMAIN}` to the hosting
 * platform so the address actually answers.
 *
 * **`hostAttached: false` means published but not reachable** — the status write
 * succeeded and the hostname did not, so `storefrontUrl` will fail TLS until it
 * is retried. Say so rather than showing a link that breaks; `hostProblem`
 * carries copy that already distinguishes Markii's fault from the merchant's.
 * Re-running deploy is the retry.
 */
export function deploySite(idOrSlug: string, init?: RequestInit) {
  return apiPost<{
    status: "live";
    storefrontUrl: string;
    hostAttached: boolean;
    hostProblem: string | null;
  }>(`/api/sites/${encodeURIComponent(idOrSlug)}/deploy`, undefined, init);
}
