import "server-only";
import { GET as analyticsOverviewGET } from "@/app/api/analytics/overview/route";
import { GET as analyticsSiteGET } from "@/app/api/analytics/sites/[idOrSlug]/route";
import { GET as billingUsageGET } from "@/app/api/billing/usage/route";
import { GET as categoriesGET } from "@/app/api/categories/route";
import { GET as categoryGET } from "@/app/api/categories/[idOrSlug]/route";
import { GET as emailSettingsGET } from "@/app/api/settings/email/route";
import { GET as financesOverviewGET } from "@/app/api/finances/overview/route";
import { GET as financesSiteGET } from "@/app/api/finances/sites/[idOrSlug]/route";
import { GET as integrationsGET } from "@/app/api/integrations/route";
import { GET as overviewGET } from "@/app/api/overview/route";
import { GET as customersGET } from "@/app/api/customers/route";
import { GET as customerGET } from "@/app/api/customers/[id]/route";
import { GET as customerOrdersGET } from "@/app/api/customers/[id]/orders/route";
import { GET as customerMembershipsGET } from "@/app/api/customers/[id]/memberships/route";
import { GET as meGET } from "@/app/api/me/route";
import { GET as membershipTiersGET } from "@/app/api/memberships/tiers/route";
import { GET as productsGET } from "@/app/api/products/route";
import { GET as productGET } from "@/app/api/products/[idOrSlug]/route";
import { GET as readinessOverviewGET } from "@/app/api/readiness/overview/route";
import { GET as sitesGET } from "@/app/api/sites/route";
import { GET as siteGET } from "@/app/api/sites/[idOrSlug]/route";
import { GET as siteSummaryGET } from "@/app/api/sites/[idOrSlug]/summary/route";
import { buildQuery, type QueryValue } from "./client";
import type { UsageResponse } from "./billing";
import type { EmailSettings } from "./email";
import type { CustomerMembership, MembershipTier } from "./memberships";
import type { Customer } from "./commerce";
import type { MeResponse } from "./org";
import type { ReadinessReport } from "./readiness";
import type { AnalyticsOverview, AnalyticsQuery, AnalyticsSiteDetail } from "./analytics";
import type { FinancesOverview, FinancesQuery, FinancesSiteDetail } from "./finances";
import type { IntegrationsResponse } from "./integrations";
import type { CategoriesQuery } from "./categories";
import type { ProductsQuery } from "./products";
import type { SiteSummary, SitesQuery } from "./sites";
import {
  ApiClientError,
  type Category,
  type Order,
  type OverviewResponse,
  type Paginated,
  type Product,
  type Site,
} from "./types";

/**
 * Server components call the route handlers in-process instead of over HTTP.
 * Same code path as a real request — so response shapes stay identical to the
 * documented contract — but without the server issuing a request to itself,
 * which doubled the work per render and forced an on-demand route compile in dev.
 *
 * Client components still use the fetch-based client in ./client.
 */
type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call<T>(
  handler: Handler,
  path: string,
  query?: Record<string, QueryValue>,
  params: Record<string, string> = {},
): Promise<T> {
  const url = `http://internal${path}${buildQuery(query)}`;
  const res = await handler(new Request(url), { params: Promise.resolve(params) });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = res.statusText || "Request failed";
    let details: unknown[] | undefined;
    try {
      const body = await res.json();
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        details = body.error.details;
      }
    } catch {
      // non-JSON error body
    }
    throw new ApiClientError(res.status, code, message, details);
  }

  // round-trip through JSON so Dates serialise exactly as they would over HTTP
  return (await res.json()) as T;
}

export const getOverview = () => call<OverviewResponse>(overviewGET, "/api/overview");

export const listSites = (query?: SitesQuery) =>
  call<Paginated<Site>>(sitesGET, "/api/sites", query as Record<string, QueryValue>);

export const getSite = (idOrSlug: string) =>
  call<Site>(siteGET, `/api/sites/${idOrSlug}`, undefined, { idOrSlug });

export const getSiteSummary = (idOrSlug: string) =>
  call<SiteSummary>(siteSummaryGET, `/api/sites/${idOrSlug}/summary`, undefined, {
    idOrSlug,
  });

export const listProducts = (query?: ProductsQuery) =>
  call<Paginated<Product>>(productsGET, "/api/products", query as Record<string, QueryValue>);

export const getProduct = (idOrSlug: string, query?: { siteId?: number }) =>
  call<Product>(productGET, `/api/products/${idOrSlug}`, query, { idOrSlug });

export const listCategories = (query?: CategoriesQuery) =>
  call<Paginated<Category>>(
    categoriesGET,
    "/api/categories",
    query as Record<string, QueryValue>,
  );

export const getCategory = (idOrSlug: string, query?: { siteId?: number }) =>
  call<Category>(categoryGET, `/api/categories/${idOrSlug}`, query, { idOrSlug });

export const getAnalyticsOverview = (query?: Pick<AnalyticsQuery, "q" | "from" | "to">) =>
  call<AnalyticsOverview>(
    analyticsOverviewGET,
    "/api/analytics/overview",
    query as Record<string, QueryValue>,
  );

export const getSiteAnalytics = (idOrSlug: string, query?: AnalyticsQuery) =>
  call<AnalyticsSiteDetail>(
    analyticsSiteGET,
    `/api/analytics/sites/${idOrSlug}`,
    query as Record<string, QueryValue>,
    { idOrSlug },
  );

export const getFinancesOverview = (query?: Pick<FinancesQuery, "q" | "from" | "to">) =>
  call<FinancesOverview>(
    financesOverviewGET,
    "/api/finances/overview",
    query as Record<string, QueryValue>,
  );

export const getSiteFinances = (idOrSlug: string, query?: FinancesQuery) =>
  call<FinancesSiteDetail>(
    financesSiteGET,
    `/api/finances/sites/${idOrSlug}`,
    query as Record<string, QueryValue>,
    { idOrSlug },
  );

export const getIntegrations = () =>
  call<IntegrationsResponse>(integrationsGET, "/api/integrations");

/**
 * Org-scoped sections (§9, §17, §24) must come through here, not the fetch
 * client, and the reason is not just efficiency.
 *
 * `requireAuthContext` resolves the caller from `cookies()` — the **ambient
 * request context**, not the `Request` object it is handed. An in-process call
 * inherits that context and authenticates. A server component that instead
 * `fetch`es its own API opens a *new* request carrying no cookie header, so it
 * authenticates as nobody and gets a `401` — which would surface as "Email
 * settings could not be loaded" on a perfectly healthy deployment.
 *
 * Client components are unaffected: the browser attaches the cookie itself.
 */
export const getReadinessOverview = (query?: {
  siteId?: number;
  productId?: number;
  environment?: "test" | "production";
}) =>
  call<ReadinessReport>(
    readinessOverviewGET,
    "/api/readiness/overview",
    query as Record<string, QueryValue>,
  );

export const getBillingUsage = () => call<UsageResponse>(billingUsageGET, "/api/billing/usage");

export const getEmailSettings = () =>
  call<EmailSettings>(emailSettingsGET, "/api/settings/email");

export const listMembershipTiers = (query?: { siteId?: number }) =>
  call<{ items: MembershipTier[] }>(
    membershipTiersGET,
    "/api/memberships/tiers",
    query as Record<string, QueryValue>,
  );

/** The caller's identity and org. `org.currency` is what money formatters need (D31). */
export const getMe = () => call<MeResponse>(meGET, "/api/me");

export const listCustomers = (query?: {
  q?: string;
  siteId?: number;
  page?: number;
  limit?: number;
}) =>
  call<Paginated<Customer>>(customersGET, "/api/customers", query as Record<string, QueryValue>);

/** Detail carries addresses and derived order stats alongside the record. */
export const getCustomer = (id: number) =>
  call<Customer & {
    addresses: CustomerAddress[];
    defaultAddressId: number | null;
  }>(customerGET, `/api/customers/${id}`, undefined, { id: String(id) });

export const getCustomerOrders = (id: number, query?: { page?: number; limit?: number }) =>
  call<{ items: Order[]; page: number; limit: number }>(
    customerOrdersGET,
    `/api/customers/${id}/orders`,
    query as Record<string, QueryValue>,
    { id: String(id) },
  );

export const getCustomerMemberships = (id: number) =>
  call<{ items: CustomerMembership[] }>(
    customerMembershipsGET,
    `/api/customers/${id}/memberships`,
    undefined,
    { id: String(id) },
  );

export type CustomerAddress = {
  id: number;
  customerId: number;
  name: string | null;
  line1: string;
  line2: string | null;
  city: string;
  province: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
};
