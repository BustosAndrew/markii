import { apiDelete, apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";

const BILLING_SECTION = "API §17";
const BILLING_API_LIVE = false;

export type Entitlements = {
  storeLimit: number;
  staffSeatLimit: number | null;
  gmvThresholdMinor: number;
  overageRateBps: number;
  addOns: { agentOps: boolean; chargebackAssist: boolean };
};

export type PlanCatalogItem = {
  planId: "starter" | "growth" | "scale";
  interval: "month" | "year";
  priceMinor: number;
  currency: string;
  verifiedAt: string | null;
  entitlements: Entitlements;
};

export type SubscriptionResponse = {
  planId: "starter" | "growth" | "scale";
  interval: "month" | "year";
  status: "trialing" | "active" | "past_due" | "canceled" | "unpaid";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  paymentMethod: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  } | null;
  entitlements: Entitlements;
};

export type UsageResponse = {
  currency: string;
  trailing12NetSalesMinor: number | null;
  thresholdMinor: number;
  overageRateBps: number;
  state: "below" | "approaching" | "above";
  period: { start: string; end: string };
  periodNetSalesMinor: number | null;
  billableThisPeriodMinor: number | null;
  feeAccruedMinor: number | null;
  projectedPeriodFeeMinor: number | null;
  projectionBasis: string | null;
  upgradeSuggestion: {
    planId: "starter" | "growth" | "scale";
    monthlyDeltaMinor: number;
    projectedAnnualSavingMinor: number;
  } | null;
  processorFeesNote: string | null;
  dataSource: "production" | "test" | "demo";
};

export type InvoiceSummary = {
  id: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  totalMinor: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  createdAt: string;
};

export function listPlans(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<{ items: PlanCatalogItem[] }>("/api/billing/plans", undefined, init),
  );
}

export function getSubscription(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<SubscriptionResponse>("/api/billing/subscription", undefined, init),
  );
}

export function updateSubscription(
  body: { planId: PlanCatalogItem["planId"]; interval: PlanCatalogItem["interval"] },
  init?: RequestInit,
) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiPost<SubscriptionResponse>("/api/billing/subscription", body, init),
  );
}

export function cancelSubscription(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiDelete<{ cancelled: true }>("/api/billing/subscription", init),
  );
}

export function getBillingUsage(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<UsageResponse>("/api/billing/usage", undefined, init),
  );
}

export function listInvoices(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<{ items: InvoiceSummary[] }>("/api/billing/invoices", undefined, init),
  );
}
