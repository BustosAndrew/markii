import { apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";

const BILLING_SECTION = "API §17";

/**
 * §17 landed in halves, and the split is exactly where Stripe starts.
 *
 * The meter, the plan catalog, entitlements, and the closed-period assessments
 * are computed from Markii's own ledger and are ✅ LIVE. Everything that needs a
 * `STRIPE_SECRET_KEY` — plan changes, cancellation, a SetupIntent — is routed
 * but refuses with `503 CONFIGURATION_REQUIRED`.
 *
 * Those refusing routes are **not** gated to `false` here. Gating them would
 * make a screen say "coming soon", which is the wrong fact: the contract is
 * agreed, the route exists, and what is missing is a credential. Let them call
 * and render the refusal — `isConfigurationRequired()` in `./planned`
 * distinguishes it from a planned section.
 */
const BILLING_API_LIVE = true;

export type PlanId = "starter" | "growth" | "scale";

export type Entitlements = {
  storeLimit: number;
  staffSeatLimit: number | null;
  gmvThresholdMinor: number;
  overageRateBps: number;
  media: { storageGb: number; egressGb: number };
  addOns: { agentOps: boolean; chargebackAssist: boolean };
};

export type PlanCatalogItem = {
  planId: PlanId;
  monthlyPriceMinor: number;
  annualPerMonthMinor: number;
  gmvThresholdMinor: number;
  overageRateBps: number;
  storeLimit: number;
  staffSeatLimit: number | null;
  media: Entitlements["media"];
  includedAddOns: Partial<Entitlements["addOns"]>;
  /** Both per month; `annualPerMonth` applies when billed yearly. */
  billing: { monthly: number; annualPerMonth: number };
};

export type PlansResponse = {
  currency: string;
  items: PlanCatalogItem[];
  /**
   * `"proposed"` — prices are not finalised (`docs/PRICING.md` §3). A screen
   * must not present them as settled.
   */
  status: "proposed";
  note: string;
  /**
   * Deliberately empty. Competitor comparisons are factual claims and must
   * carry a verification date from `docs/COMPETITORS.md` — never hardcoded.
   */
  comparisons: never[];
  comparisonsNote: string;
};

export type UpgradeSuggestion = {
  planId: string;
  monthlyDeltaMinor: number;
  projectedAnnualSavingMinor: number;
} | null;

export type UsageResponse = {
  currency: string;
  /** Null until a first production sale exists — never 0, which reads as "nothing sold". */
  trailing12NetSalesMinor: number | null;
  thresholdMinor: number;
  overageRateBps: number;
  /** Null when nothing has been measured yet — do not render it as "below". */
  state: "below" | "approaching" | "above" | null;
  period: { start: string; end: string };
  periodNetSalesMinor: number | null;
  billableThisPeriodMinor: number | null;
  feeAccruedMinor: number | null;
  projectedPeriodFeeMinor: number | null;
  projectionBasis: "run_rate_to_period_end" | null;
  upgradeSuggestion: UpgradeSuggestion;
  processorFeesNote: string;
  dataSource: "production" | "not_yet_measured";
  /**
   * Sales whose currency could not be converted, so the total above is
   * known-incomplete. No FX provider is wired; these are excluded rather than
   * summed as zero, and the count is what makes the gap visible.
   */
  unconvertedRecordCount: number;
  /** What the merchant is actually charged right now, and why. Always surface it. */
  billingStatus: { charging: boolean; reason: string };
};

export type SubscriptionResponse = {
  planId: PlanId;
  /** What screens gate on — never the plan name (`docs/PRICING.md` §5). */
  entitlements: Entitlements;
  pricing: {
    monthlyPriceMinor: number;
    annualPerMonthMinor: number;
    currency: string;
    status: "proposed";
  };
  /** The metering window the threshold fee is computed over — **not** a Stripe billing period. */
  meteringPeriod: { start: string; end: string; basis: "calendar_month" };
  /** Null: no Stripe subscription object exists on this deployment. */
  subscription: null;
  subscriptionState: {
    code: "configuration_required";
    message: string;
    resolution: string;
    charging: false;
  };
};

/**
 * A closed period's fee assessment — **not an invoice**.
 *
 * An invoice is a demand for payment raised by Stripe Billing, which is not
 * connected. These rows are what each period measured; an invoice will one day
 * cite them rather than replace them.
 */
export type FeeAssessment = {
  id: string;
  periodStart: string;
  periodEnd: string;
  planId: PlanId;
  currency: string;
  thresholdMinor: number;
  overageRateBps: number;
  t12NetSalesMinor: number;
  periodNetSalesMinor: number;
  billableMinor: number;
  feeMinor: number;
  /** The formula's own inputs — "why this number" answered from the row. */
  workings: unknown;
  recordCount: number;
  invoiced: boolean;
  closedAt: string;
};

export type InvoicesResponse = {
  assessments: FeeAssessment[];
  total: number;
  page: number;
  limit: number;
  invoices: never[];
  invoicesState: {
    code: "configuration_required";
    message: string;
    resolution: string;
  };
};

export function listPlans(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<PlansResponse>("/api/billing/plans", undefined, init),
  );
}

export function getSubscription(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<SubscriptionResponse>("/api/billing/subscription", undefined, init),
  );
}

/**
 * Refuses with `503 CONFIGURATION_REQUIRED` until Stripe Billing is connected.
 *
 * It does not quietly move `organizations.planId` instead: that would grant a
 * higher threshold and extra storefronts with nothing sold behind them.
 */
export function updateSubscription(
  body: { planId: PlanId; interval: "month" | "year" },
  init?: RequestInit,
) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiPost<SubscriptionResponse>("/api/billing/subscription", body, init),
  );
}

export function getBillingUsage(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<UsageResponse>("/api/billing/usage", undefined, init),
  );
}

export function listInvoices(
  query?: { page?: number; limit?: number },
  init?: RequestInit,
) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<InvoicesResponse>("/api/billing/invoices", query, init),
  );
}

/**
 * A Stripe SetupIntent client secret. Refuses until Stripe is connected — a
 * fake secret fails inside Stripe's own card element, after the merchant has
 * typed their card number.
 */
export function createSetupIntent(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiPost<{ clientSecret: string }>("/api/billing/payment-method", undefined, init),
  );
}
