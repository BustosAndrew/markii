import { apiDelete, apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";

const BILLING_SECTION = "API §17";

/**
 * §17 is now ✅ LIVE **in full** — subscriptions, plan changes with a proration
 * preview, payment methods, invoices, and threshold-fee invoicing.
 *
 * It previously landed in halves, and these types described the earlier half:
 * `subscription` was pinned to `null` and `invoices` to `never[]`, which was
 * accurate when nothing could exist. Left alone they would have been worse than
 * stale — TypeScript would have stopped a screen from reading data the API was
 * really returning, which is the two-sided-flip failure `docs/FRONTEND.md`
 * records. **Backend owns correcting this in the same change that moves the
 * badge.**
 *
 * One route still refuses by design: buying an add-on answers `409`, because
 * Agent Ops and Chargeback Assist do not exist. That is not gated to `false`
 * either — the contract is agreed and the route is real; what is missing is the
 * product. Let it call and render the refusal.
 */
const BILLING_API_LIVE = true;

export type PlanId = "starter" | "growth" | "scale";
export type BillingInterval = "month" | "year";

export type Entitlements = {
  storeLimit: number;
  staffSeatLimit: number | null;
  gmvThresholdMinor: number;
  /** Per fee class — physical and digital bill at different rates (D39). */
  overageRateBps: { physical: number; digital: number };
  media: { storageGb: number; monthlyEgressGb: number };
  addOns: { agentOps: boolean; chargebackAssist: boolean };
};

export type PlanCatalogItem = {
  planId: PlanId;
  monthlyPriceMinor: number;
  annualPerMonthMinor: number;
  gmvThresholdMinor: number;
  overageRateBps: { physical: number; digital: number };
  storeLimit: number;
  staffSeatLimit: number | null;
  media: Entitlements["media"];
  includedAddOns: Partial<Entitlements["addOns"]>;
  /** Both per month; `annualPerMonth` applies when billed yearly. */
  billing: { monthly: number; annualPerMonth: number };
};

/**
 * Whether a displayed price is a settled commitment.
 *
 * `"proposed"` meant "do not present this as final" and every price surface
 * carried a caveat because of it. The §3 plan schedule was signed off on
 * 2026-08-10, so plan prices are `"final"`. Add-on prices are **still
 * `"proposed"`** — Agent Ops and Chargeback Assist do not exist and their
 * pricing was never part of that sign-off.
 */
export type PriceStatus = "proposed" | "final";

export type PlansResponse = {
  currency: string;
  items: PlanCatalogItem[];
  /**
   * `"final"` since 2026-08-10 — the owner signed off the §3 plan schedule, so
   * screens may present these as settled prices.
   *
   * **Kept as a union rather than swapped to a bare `"final"` literal.** Pinning
   * it to one value is what made this a breaking change to flip, and prices can
   * move again. Read it; do not assume it.
   */
  status: PriceStatus;
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
  /** The same figure for both classes on a plan; each is measured against it separately. */
  thresholdMinor: number;
  /** Per class, because the rates differ (D39). */
  overageRateBps: { physical: number; digital: number };
  /**
   * One meter per fee class. Physical and digital run against **separate**
   * thresholds (D39), so this is what must be rendered — a single bar of the
   * combined total can show a merchant over a line neither class crossed.
   * Empty before a first production sale.
   */
  byClass: {
    productClass: "physical" | "digital";
    trailing12NetSalesMinor: number;
    thresholdMinor: number;
    overageRateBps: number;
    state: "below" | "approaching" | "above";
    periodNetSalesMinor: number;
    billableThisPeriodMinor: number;
    feeAccruedMinor: number;
    projectedPeriodFeeMinor: number | null;
  }[];
  /** The worse of the two classes, so a merchant over on either sees it. */
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
  /**
   * Sales metered before the physical/digital split existed (D39). They are in
   * `trailing12NetSalesMinor` but in neither class meter, so the parts will not
   * add to the total — reported rather than silently bucketed.
   */
  unclassifiedRecordCount: number;
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
    status: PriceStatus;
  };
  /** The metering window the threshold fee is computed over — **not** a Stripe billing period. */
  meteringPeriod: { start: string; end: string; basis: "calendar_month" };
  /** Null when this org has never subscribed. */
  subscription: Subscription | null;
  /** Present only when the card lookup itself failed — distinct from "no card". */
  paymentMethodState: { code: "unavailable"; message: string } | null;
  subscriptionState: {
    code: "active" | "not_subscribed" | "inactive" | "configuration_required";
    message: string;
    resolution?: string;
    /** Whether the *subscription* is charging. Threshold fees are reported separately. */
    charging: boolean;
    thresholdFeesCharging?: boolean;
  };
};

export type Subscription = {
  planId: PlanId;
  interval: BillingInterval | null;
  /**
   * Stored verbatim from Stripe, so wider than the five worth rendering:
   * `incomplete`, `incomplete_expired`, and `paused` also occur.
   */
  status: string;
  /** Stripe's billing period — **not** the metering period above. */
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  /**
   * **Gate on this, not on `status` and not on the subscription merely
   * existing.** A subscription can exist and grant nothing — `incomplete` is one
   * whose first invoice was never paid — and showing a tier for it would tell a
   * merchant they are on a plan nobody is charging them for.
   */
  entitlesPlan: boolean;
};

/**
 * A closed period's fee assessment — **not an invoice**.
 *
 * An invoice is a demand for payment; an assessment is what a period *measured*.
 * They now both exist and arrive under separate keys, and **must not be merged
 * into one list**.
 */
export type FeeAssessment = {
  id: string;
  periodStart: string;
  periodEnd: string;
  planId: PlanId;
  /** Null on assessments closed before physical/digital split (D39). */
  productClass: "physical" | "digital" | null;
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
  /**
   * Null on an `invoiced` row means **settled, nothing owed** — the merchant was
   * under their threshold. `invoiced` alone cannot express that, so render the
   * two together or a $0 period reads as an unpaid bill.
   */
  stripeInvoiceItemId: string | null;
  invoicedAt: string | null;
  closedAt: string;
};

export type InvoiceLine = {
  description: string;
  amountMinor: number;
  quantity: number | null;
  /** Set on a threshold-fee line, linking it to the assessment that produced it. */
  assessmentId?: string | null;
};

export type Invoice = {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  amountDueMinor: number;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** Stripe-hosted. Link these — never proxy or re-render a merchant's invoice. */
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  lines: InvoiceLine[];
};

/** `GET /api/billing/invoices/:id` — lines carry the assessment behind a fee. */
export type InvoiceDetail = Omit<Invoice, "lines"> & {
  lines: (InvoiceLine & { feeAssessment: FeeAssessment | null })[];
  documentsAreStripeHosted: true;
};

export type InvoicesResponse = {
  assessments: FeeAssessment[];
  total: number;
  page: number;
  limit: number;
  /** Stripe's real invoices. Empty is a real answer, not a placeholder. */
  invoices: Invoice[];
  /** Null when invoices were fetched fine — the states are why the list is empty. */
  invoicesState:
    | { code: "configuration_required"; message: string; resolution?: string }
    | { code: "not_subscribed"; message: string }
    | { code: "unavailable"; message: string }
    | null;
  /** Null when there are no assessments to describe. */
  assessmentsState:
    | { code: "pending"; message: string; resolution?: string }
    | { code: "billed"; message: string }
    | null;
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
 * Mutating billing routes delegate to the action registry (§22), so they return
 * an **invocation outcome** rather than the resource. The value is under
 * `result`.
 */
export type ActionOutcome<T> = {
  invocationId: string;
  ok: boolean;
  result?: T;
  dryRun: boolean;
};

export type PlanChangePreview = {
  kind: "first_subscription" | "plan_change";
  amountDueMinor: number;
  currency: string;
  lines: { description: string; amountMinor: number }[];
  nextChargeAt: string | null;
};

export type PlanChangeResult = {
  /** False on a preview. Nothing was charged and no entitlement moved. */
  confirmed: boolean;
  charging: boolean;
  note: string;
  /** Present only on a preview. */
  preview?: PlanChangePreview;
  subscriptionId?: string;
  status?: string;
  planId?: PlanId;
  /** Present when a first subscription needs confirming in Stripe Elements. */
  clientSecret?: string | null;
  publishableKey?: string | null;
};

/**
 * Change plan — **two steps, and the first one writes nothing.**
 *
 * Without `confirm: true` this returns Stripe's own proration preview
 * (`result.preview`); call again with `confirm: true` to apply exactly what the
 * merchant was shown. Do not compute the amount locally — proration depends on
 * elapsed period, existing credits, and customer balance, so a local estimate
 * will sometimes disagree with the real charge.
 *
 * `organizations.planId` moves only once Stripe says the subscription is paid,
 * so a `confirmed` response with an `incomplete` status has **not** granted the
 * plan yet.
 */
export function updateSubscription(
  body: { planId: PlanId; interval?: BillingInterval; confirm?: boolean },
  init?: RequestInit,
) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiPost<ActionOutcome<PlanChangeResult>>("/api/billing/subscription", body, init),
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

/** One invoice, line-itemized. A fee line carries the assessment behind it. */
export function getInvoice(id: string, init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<InvoiceDetail>(`/api/billing/invoices/${encodeURIComponent(id)}`, undefined, init),
  );
}

/**
 * Cancel at period end. **Never immediate** — the merchant paid through the end
 * of the period, so a consequence summary should say what they keep and until
 * when (`subscription.currentPeriodEnd`).
 */
export function cancelSubscription(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiDelete<ActionOutcome<{ cancelAtPeriodEnd: boolean; endsAt: string | null }>>(
      "/api/billing/subscription",
      init,
    ),
  );
}

/**
 * A Stripe SetupIntent client secret, plus the publishable key Elements must
 * mount with.
 *
 * **Use the returned `publishableKey`, never one read from elsewhere.** The
 * server refuses when the publishable and secret keys are in different Stripe
 * modes — a `pk_live_` cannot confirm a secret issued by an `sk_test_` — and
 * handing you the key it validated is how it tells you which one is safe.
 */
export function createSetupIntent(init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiPost<ActionOutcome<{ clientSecret: string; publishableKey: string; customerId: string }>>(
      "/api/billing/payment-method",
      undefined,
      init,
    ),
  );
}

/**
 * **Required after Elements confirms a SetupIntent.** Attaching a card does not
 * make it the one invoices are charged to — skip this and the merchant sees a
 * saved card while the next renewal fails against nothing.
 */
export function setDefaultPaymentMethod(paymentMethodId: string, init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiPost<ActionOutcome<{ applied: boolean }>>(
      "/api/actions/billing.setDefaultPaymentMethod",
      { paymentMethodId },
      init,
    ),
  );
}

export type Addon = "agentOps" | "chargebackAssist";

export type AddonResponse = {
  addon: Addon;
  label: string;
  /** What gates read. True via purchase **or** because the plan includes it. */
  entitled: boolean;
  includedInPlan: boolean;
  purchased: boolean;
  /**
   * Add-on prices stay `"proposed"`. The 2026-08-10 sign-off covered the §3
   * plan schedule; Agent Ops and Chargeback Assist do not exist and their
   * prices were never part of it.
   */
  pricing: { monthlyPriceMinor: number; currency: string; status: PriceStatus };
  /** Always `not_built` today — the products do not exist. */
  availability: { code: "not_built"; message: string; detail: string };
};

/**
 * What the org actually has. Render `includedInPlan` apart from `purchased` — a
 * Scale merchant already has Chargeback Assist and must not be asked to buy it.
 *
 * There is deliberately **no purchase function here.** `POST` answers `409`
 * because Agent Ops and Chargeback Assist do not exist, so show them as
 * unavailable with the reason — never as an upsell with a working buy button.
 */
export function getAddon(addon: Addon, init?: RequestInit) {
  return callWhenLive(BILLING_API_LIVE, BILLING_SECTION, () =>
    apiGet<AddonResponse>(`/api/billing/addons/${addon}`, undefined, init),
  );
}
