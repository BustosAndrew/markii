import "server-only";
import type { PlanId } from "../db";
import { planPricing } from "../plans";
import { matchedPublishableKey } from "../stripe-mode";

/**
 * Stripe Billing — **Markii charging the merchant** (§17).
 *
 * This is the opposite side of the money from `lib/payments/`. Everything in
 * that folder runs against a *merchant's* Connect account with a
 * `Stripe-Account` header, takes no `application_fee_amount`, and never puts
 * Markii in the funds flow (D4). Nothing here sends that header: the customer,
 * the subscription, and the invoice all live on **Markii's own platform
 * account**, because the merchant is the one being charged.
 *
 * Confusing the two would be the most expensive mistake available in this
 * codebase — a subscription created with `Stripe-Account` would bill the
 * merchant's own customers on the merchant's own account for Markii's software.
 * That is why there is no account parameter anywhere in this file, rather than
 * an optional one that defaults to undefined.
 *
 * Hand-rolled over `fetch`, matching `stripe-charges.ts`, the Connect OAuth
 * code, the webhook signature check, and the SES SigV4 transport.
 */

const API = "https://api.stripe.com/v1";

/**
 * Pinned rather than inherited from the account's default.
 *
 * The proration preview below is `POST /v1/invoices/create_preview`, which
 * replaced `GET /v1/invoices/upcoming` in the 2025-03-31 API version. Letting
 * the account's dashboard setting decide which one exists would make a plan
 * change work on one deployment and 404 on another, with no code difference to
 * explain it — and the failure would land on a merchant mid-upgrade.
 */
const API_VERSION = "2025-03-31.basil";

export type StripeFailure = {
  ok: false;
  code: "configuration_required" | "unavailable";
  message: string;
  resolution?: string;
  /**
   * Stripe's HTTP status, when the failure came from Stripe rather than from the
   * network. Callers need it to tell "this object does not exist" (404, safe to
   * recreate) from "Stripe did not answer" (safe to retry, **never** safe to
   * recreate) — recreating on the second would leave two customers with two
   * cards, only one of which the merchant can see.
   */
  status?: number;
};

/** True when Markii's own platform credentials exist. Merchant connection is separate. */
export function billingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Re-exported so callers of this module do not have to know the guard is shared
 * with the card rail — it is the same hazard on both sides of the money.
 */
export { matchedPublishableKey } from "../stripe-mode";

const missingCredentials: StripeFailure = {
  ok: false,
  code: "configuration_required",
  message: "Stripe Billing is not connected on this deployment.",
  resolution: "This deployment needs additional platform configuration. Contact your Markii admin.",
};

/**
 * One request, one place that knows the auth header, the version pin, and the
 * form encoding.
 *
 * Errors come back as values, never thrown. A billing route that throws on a
 * Stripe outage returns a 500 that reads like a bug in Markii; a returned
 * failure carries Stripe's own wording, which is usually the actionable part
 * ("Your card was declined" is a merchant task, not ours).
 */
async function call<T>(
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: URLSearchParams; idempotencyKey?: string },
): Promise<{ ok: true; data: T } | StripeFailure> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return missingCredentials;

  const headers: Record<string, string> = {
    authorization: `Bearer ${secret}`,
    "Stripe-Version": API_VERSION,
  };
  if (init.body) headers["content-type"] = "application/x-www-form-urlencoded";
  /**
   * Only on writes, and only when the caller supplied a key derived from
   * something stable. A random key per attempt is the same as no key at all —
   * the retry it exists to protect would carry a different one.
   */
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init.method,
      headers,
      body: init.body?.toString(),
    });
  } catch (e) {
    return {
      ok: false,
      code: "unavailable",
      message: e instanceof Error ? e.message : "Could not reach Stripe.",
    };
  }

  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    return {
      ok: false,
      code: "unavailable",
      message: json.error?.message ?? `Stripe returned ${res.status}.`,
      status: res.status,
    };
  }
  return { ok: true, data: json };
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * The price catalog — what a Price *should* be — lives in `./price-catalog`,
 * which is deliberately not `server-only` so `scripts/stripe-prices.ts` can
 * create exactly what `resolvePrice` below verifies. Re-exported here so every
 * existing caller keeps importing from one place.
 *
 * Lookup keys rather than six `STRIPE_PRICE_*` environment variables: the key is
 * derivable from the plan and interval, so adding a plan needs no configuration
 * redeploy, and a missing one names itself in the error.
 */
export {
  priceLookupKey,
  expectedUnitAmountMinor,
  type BillingInterval,
} from "./price-catalog";
import {
  expectedUnitAmountMinor,
  priceLookupKey,
  type BillingInterval,
} from "./price-catalog";

export type ResolvedPrice = { id: string; unitAmountMinor: number; currency: string; interval: BillingInterval };

/**
 * Resolves a plan + interval to a Stripe Price, and **refuses when Stripe's
 * amount disagrees with the plan table**.
 *
 * The check is the point. `lib/plans.ts` is what every screen renders and what
 * `GET /api/billing/plans` publishes; the Stripe Price is what actually gets
 * charged. Nothing keeps them in step automatically, so a Price edited in the
 * Stripe dashboard — or a `markii_growth_year` created with the per-month
 * figure by mistake — would show a merchant one number and take another. That
 * is a billing dispute, and it is silent until someone reads their statement.
 *
 * Refusing is safe in a way that guessing is not: the plan change does not
 * happen, the merchant keeps their current plan, and the error says exactly
 * which price is wrong and what it should be.
 */
export async function resolvePrice(
  planId: PlanId,
  interval: BillingInterval,
): Promise<{ ok: true; price: ResolvedPrice } | StripeFailure> {
  const lookupKey = priceLookupKey(planId, interval);
  const res = await call<{ data?: { id?: string; unit_amount?: number; currency?: string; active?: boolean; recurring?: { interval?: string } }[] }>(
    `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=2`,
    { method: "GET" },
  );
  if (!res.ok) return res;

  const found = res.data.data ?? [];
  if (found.length === 0) {
    return {
      ok: false,
      code: "configuration_required",
      message: `No active Stripe Price with lookup key "${lookupKey}".`,
      resolution:
        `Create a recurring Price on Markii's own Stripe account with lookup_key "${lookupKey}", ` +
        `interval "${interval}", and unit_amount ${expectedUnitAmountMinor(planId, interval)} ` +
        `(minor units, USD). Plan prices are still proposed.`,
    };
  }
  if (found.length > 1) {
    /**
     * Stripe allows a lookup key to be transferred but not duplicated among
     * active prices, so two here means something unexpected. Picking the first
     * would pick by list order, which is not a decision anyone made.
     */
    return {
      ok: false,
      code: "configuration_required",
      message: `More than one active Stripe Price carries lookup key "${lookupKey}".`,
      resolution: "Archive the duplicates so exactly one active price answers to that key.",
    };
  }

  const price = found[0];
  const expected = expectedUnitAmountMinor(planId, interval);
  if (!price.id || price.unit_amount == null) {
    return { ok: false, code: "unavailable", message: `Stripe returned an unusable price for "${lookupKey}".` };
  }
  if (price.unit_amount !== expected) {
    return {
      ok: false,
      code: "configuration_required",
      message:
        `Stripe Price "${lookupKey}" charges ${price.unit_amount} but the plan table says ${expected}.`,
      resolution:
        "Markii refuses to bill an amount it does not display. Fix the Price in Stripe, or fix " +
        "lib/plans.ts — whichever is wrong — so the merchant is charged what they were shown.",
    };
  }
  if (price.recurring?.interval !== interval) {
    return {
      ok: false,
      code: "configuration_required",
      message: `Stripe Price "${lookupKey}" recurs ${price.recurring?.interval ?? "not at all"}, not ${interval}.`,
      resolution: "The lookup key names the interval; the price must match it.",
    };
  }

  return {
    ok: true,
    price: {
      id: price.id,
      unitAmountMinor: price.unit_amount,
      currency: (price.currency ?? "usd").toUpperCase(),
      interval,
    },
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Finds or creates the platform Customer for an organization.
 *
 * The caller persists the returned id — this does not write to the database,
 * because it is also called from paths that must not (a preview, a read). The
 * idempotency key is the org id, so two concurrent first-time calls collide
 * inside Stripe rather than creating two customers with two payment methods,
 * only one of which the merchant can see.
 */
export async function ensureCustomer(input: {
  orgId: string;
  existingCustomerId: string | null;
  name: string;
  email: string;
}): Promise<{ ok: true; customerId: string; created: boolean } | StripeFailure> {
  if (input.existingCustomerId) {
    const existing = await call<{ id?: string; deleted?: boolean }>(
      `/customers/${encodeURIComponent(input.existingCustomerId)}`,
      { method: "GET" },
    );
    /**
     * A customer deleted in the Stripe dashboard still returns 200 with
     * `deleted: true`. Treating that as usable would attach a payment method to
     * a tombstone and then fail at the first invoice.
     */
    if (existing.ok && existing.data.id && !existing.data.deleted) {
      return { ok: true, customerId: existing.data.id, created: false };
    }
    /**
     * **Only a definite "it is gone" justifies creating a replacement.** A 404,
     * or a 200 carrying `deleted: true`, means the stored id is a tombstone and
     * a new customer is the repair. Anything else — a timeout, a 500, a rate
     * limit — means Stripe did not answer, and the customer is probably alive
     * with the merchant's card on it. Recreating there would leave two
     * customers, bill the empty one, and be invisible until the first renewal
     * failed.
     */
    const gone = existing.ok
      ? Boolean(existing.data.deleted)
      : existing.code === "unavailable" && existing.status === 404;
    if (!gone) {
      return existing.ok
        ? { ok: false, code: "unavailable", message: "Stripe returned an unusable customer." }
        : existing;
    }
  }

  const body = new URLSearchParams({
    name: input.name,
    email: input.email,
    "metadata[markii_org_id]": input.orgId,
  });
  const created = await call<{ id?: string }>("/customers", {
    method: "POST",
    body,
    idempotencyKey: `markii_customer_${input.orgId}`,
  });
  if (!created.ok) return created;
  if (!created.data.id) {
    return { ok: false, code: "unavailable", message: "Stripe created no customer id." };
  }
  return { ok: true, customerId: created.data.id, created: true };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Stripe's subscription, reduced to what Markii stores and shows.
 *
 * `planId` is resolved from the price's lookup key rather than from whatever
 * the caller asked for, so the mirror reflects what Stripe actually has. If a
 * plan change half-applied, this reports the real state instead of the intended
 * one.
 */
export type SubscriptionSnapshot = {
  subscriptionId: string;
  customerId: string;
  planId: PlanId | null;
  interval: BillingInterval | null;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** The single subscription item, which is what a plan change swaps. */
  itemId: string | null;
};

type StripeSubscription = {
  id?: string;
  customer?: string | { id?: string };
  status?: string;
  cancel_at_period_end?: boolean;
  trial_end?: number | null;
  items?: {
    data?: {
      id?: string;
      current_period_start?: number | null;
      current_period_end?: number | null;
      price?: { id?: string; lookup_key?: string | null; recurring?: { interval?: string } };
    }[];
  };
};

const secondsToDate = (s: number | null | undefined): Date | null =>
  typeof s === "number" && Number.isFinite(s) ? new Date(s * 1000) : null;

/** Recovers the plan from a price's lookup key — the inverse of `priceLookupKey`. */
function planFromLookupKey(key: string | null | undefined): { planId: PlanId | null; interval: BillingInterval | null } {
  const m = /^markii_(starter|growth|scale)_(month|year)$/.exec(key ?? "");
  return m
    ? { planId: m[1] as PlanId, interval: m[2] as BillingInterval }
    : { planId: null, interval: null };
}

export function toSnapshot(sub: StripeSubscription): SubscriptionSnapshot | null {
  if (!sub.id) return null;
  const item = sub.items?.data?.[0];
  const { planId, interval } = planFromLookupKey(item?.price?.lookup_key);
  return {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? ""),
    planId,
    interval,
    status: sub.status ?? "incomplete",
    /**
     * Period bounds moved from the subscription onto the item in the 2025-03-31
     * API version. Reading the old top-level fields would store nulls and make
     * every renewal date in the dashboard blank.
     */
    currentPeriodStart: secondsToDate(item?.current_period_start),
    currentPeriodEnd: secondsToDate(item?.current_period_end),
    trialEndsAt: secondsToDate(sub.trial_end),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    itemId: item?.id ?? null,
  };
}

/** Reads a subscription back from Stripe. The authority for what a merchant is on. */
export async function retrieveSubscription(
  subscriptionId: string,
): Promise<{ ok: true; snapshot: SubscriptionSnapshot } | StripeFailure> {
  const res = await call<StripeSubscription>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "GET" },
  );
  if (!res.ok) return res;
  const snapshot = toSnapshot(res.data);
  if (!snapshot) return { ok: false, code: "unavailable", message: "Stripe returned an unusable subscription." };
  return { ok: true, snapshot };
}

/**
 * Creates the first subscription for an org.
 *
 * `payment_behavior=default_incomplete` on purpose: the subscription starts
 * `incomplete` and only becomes `active` once the first invoice is paid. The
 * alternative leaves a merchant looking subscribed while the charge is still
 * unconfirmed, and `organizations.plan_id` is what gates storefront limits —
 * granting them on an unpaid subscription is the free-upgrade hole this whole
 * route was refusing to open.
 */
export async function createSubscription(input: {
  customerId: string;
  priceId: string;
  orgId: string;
}): Promise<{ ok: true; snapshot: SubscriptionSnapshot; clientSecret: string | null } | StripeFailure> {
  const body = new URLSearchParams({
    customer: input.customerId,
    "items[0][price]": input.priceId,
    payment_behavior: "default_incomplete",
    "payment_settings[save_default_payment_method]": "on_subscription",
    "expand[]": "latest_invoice.confirmation_secret",
    "metadata[markii_org_id]": input.orgId,
  });
  const res = await call<StripeSubscription & {
    latest_invoice?: { confirmation_secret?: { client_secret?: string } };
  }>("/subscriptions", {
    method: "POST",
    body,
    /**
     * Keyed on org + price, so a double-submitted upgrade reuses the first
     * subscription rather than opening a second one the merchant would be
     * billed for twice.
     */
    idempotencyKey: `markii_sub_${input.orgId}_${input.priceId}`,
  });
  if (!res.ok) return res;
  const snapshot = toSnapshot(res.data);
  if (!snapshot) return { ok: false, code: "unavailable", message: "Stripe returned an unusable subscription." };
  return {
    ok: true,
    snapshot,
    /** Confirmed by Stripe Elements in the browser; card data never reaches Markii. */
    clientSecret: res.data.latest_invoice?.confirmation_secret?.client_secret ?? null,
  };
}

/**
 * Moves an existing subscription onto a different price.
 *
 * The existing item is **replaced by id** rather than a new one added. Posting
 * `items[0][price]` without `items[0][id]` appends a second line, and the
 * merchant is then billed for both plans at once.
 */
export async function changeSubscriptionPrice(input: {
  subscriptionId: string;
  itemId: string;
  priceId: string;
}): Promise<{ ok: true; snapshot: SubscriptionSnapshot } | StripeFailure> {
  const body = new URLSearchParams({
    "items[0][id]": input.itemId,
    "items[0][price]": input.priceId,
    /**
     * Stripe's default, stated explicitly. An upgrade mid-period bills the
     * difference now and a downgrade credits it, which is what the preview the
     * merchant just approved was computed with.
     */
    proration_behavior: "create_prorations",
    /** A plan change is a decision to stay; it clears a pending cancellation. */
    cancel_at_period_end: "false",
  });
  const res = await call<StripeSubscription>(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    { method: "POST", body },
  );
  if (!res.ok) return res;
  const snapshot = toSnapshot(res.data);
  if (!snapshot) return { ok: false, code: "unavailable", message: "Stripe returned an unusable subscription." };
  return { ok: true, snapshot };
}

/**
 * Cancels at period end (§17 `DELETE`), never immediately.
 *
 * The merchant paid for the period; ending it now would delete access they
 * already bought. It also keeps the downgrade honest — entitlements stay put
 * until `customer.subscription.deleted` arrives at the boundary, rather than
 * dropping a merchant below their storefront limit the moment they click.
 */
export async function cancelAtPeriodEnd(
  subscriptionId: string,
  cancel: boolean,
): Promise<{ ok: true; snapshot: SubscriptionSnapshot } | StripeFailure> {
  const res = await call<StripeSubscription>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "POST", body: new URLSearchParams({ cancel_at_period_end: String(cancel) }) },
  );
  if (!res.ok) return res;
  const snapshot = toSnapshot(res.data);
  if (!snapshot) return { ok: false, code: "unavailable", message: "Stripe returned an unusable subscription." };
  return { ok: true, snapshot };
}

// ---------------------------------------------------------------------------
// Proration preview
// ---------------------------------------------------------------------------

export type ProrationPreview = {
  /** What the merchant owes now for the change. Negative is a credit. */
  amountDueMinor: number;
  currency: string;
  /** Each proration line, so the number can show its own arithmetic. */
  lines: { description: string; amountMinor: number }[];
  /** When the next full charge lands, so "and then?" is answered too. */
  nextChargeAt: string | null;
};

/**
 * What a plan change would cost, computed by Stripe rather than by Markii.
 *
 * §17 requires a proration preview *before* commit, and this is the only way to
 * get a number that matches what will actually be charged: proration depends on
 * exactly how much of the period has elapsed, which credits Stripe has already
 * applied, and the customer's balance. Recomputing that here would produce a
 * figure that is close, differs occasionally, and is wrong in the merchant's
 * favour or ours at random.
 *
 * Read-only — `create_preview` is a POST because of the argument size, not
 * because it writes anything.
 */
export async function previewPlanChange(input: {
  customerId: string;
  subscriptionId: string;
  itemId: string;
  priceId: string;
}): Promise<{ ok: true; preview: ProrationPreview } | StripeFailure> {
  const body = new URLSearchParams({
    customer: input.customerId,
    subscription: input.subscriptionId,
    "subscription_details[items][0][id]": input.itemId,
    "subscription_details[items][0][price]": input.priceId,
    "subscription_details[proration_behavior]": "create_prorations",
  });
  const res = await call<{
    amount_due?: number;
    currency?: string;
    next_payment_attempt?: number | null;
    period_end?: number | null;
    lines?: { data?: { description?: string | null; amount?: number }[] };
  }>("/invoices/create_preview", { method: "POST", body });
  if (!res.ok) return res;

  return {
    ok: true,
    preview: {
      amountDueMinor: res.data.amount_due ?? 0,
      currency: (res.data.currency ?? "usd").toUpperCase(),
      lines: (res.data.lines?.data ?? []).map((l) => ({
        description: l.description ?? "Proration",
        amountMinor: l.amount ?? 0,
      })),
      nextChargeAt: secondsToDate(res.data.next_payment_attempt ?? res.data.period_end)?.toISOString() ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

/**
 * A SetupIntent client secret for Stripe Elements (§17).
 *
 * Card data goes only to Stripe-hosted Elements and never touches Markii
 * (PCI SAQ-A). `usage=off_session` because the card is being stored to charge
 * the subscription later without the merchant present — collecting it as
 * `on_session` produces a saved card that fails at the first renewal for
 * missing authentication.
 */
export async function createSetupIntent(
  customerId: string,
): Promise<{ ok: true; clientSecret: string; publishableKey: string | null } | StripeFailure> {
  const res = await call<{ client_secret?: string }>("/setup_intents", {
    method: "POST",
    body: new URLSearchParams({ customer: customerId, usage: "off_session" }),
  });
  if (!res.ok) return res;
  if (!res.data.client_secret) {
    return { ok: false, code: "unavailable", message: "Stripe returned no SetupIntent client secret." };
  }
  return {
    ok: true,
    clientSecret: res.data.client_secret,
    /**
     * Elements cannot mount without it, and cannot confirm this secret with a
     * key from the other mode. Null covers both, and reporting it beats
     * rendering a card form that can never submit — the same rule the checkout
     * rail follows.
     */
    publishableKey: matchedPublishableKey(),
  };
}

export type CardSummary = { brand: string; last4: string; expMonth: number; expYear: number } | null;

/** The card an invoice would actually be charged to, as §17's `Subscription.paymentMethod`. */
export async function defaultCard(customerId: string): Promise<{ ok: true; card: CardSummary } | StripeFailure> {
  const res = await call<{
    invoice_settings?: { default_payment_method?: string | { id?: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } } };
  }>(`/customers/${encodeURIComponent(customerId)}?expand[]=invoice_settings.default_payment_method`, {
    method: "GET",
  });
  if (!res.ok) return res;

  const pm = res.data.invoice_settings?.default_payment_method;
  if (!pm || typeof pm === "string" || !pm.card) return { ok: true, card: null };
  return {
    ok: true,
    card: {
      brand: pm.card.brand ?? "card",
      last4: pm.card.last4 ?? "????",
      expMonth: pm.card.exp_month ?? 0,
      expYear: pm.card.exp_year ?? 0,
    },
  };
}

/**
 * Makes a newly collected payment method the customer's default.
 *
 * Attaching a card in Elements does **not** make it the default — without this
 * the merchant adds a card, sees it saved, and the next invoice still fails
 * against nothing.
 */
export async function setDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string,
): Promise<{ ok: true } | StripeFailure> {
  const res = await call<Record<string, unknown>>(`/customers/${encodeURIComponent(customerId)}`, {
    method: "POST",
    body: new URLSearchParams({ "invoice_settings[default_payment_method]": paymentMethodId }),
  });
  return res.ok ? { ok: true } : res;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export type InvoiceSummary = {
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
  /** Stripe-hosted, so nothing here renders or stores a PDF. */
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  lines: {
    description: string;
    amountMinor: number;
    quantity: number | null;
    /** Set on a threshold-fee line, linking it to the assessment it came from. */
    assessmentId?: string | null;
  }[];
};

/**
 * One invoice, **scoped to the customer that asked for it**.
 *
 * The id comes from the URL, so it is a caller-supplied identifier for an object
 * in a namespace shared by every Markii merchant. Fetching it and returning it
 * would let any authenticated merchant read any other merchant's invoice — their
 * legal name, address, spend, and plan — by guessing or replaying an `in_…`.
 * Stripe will happily serve it, because the platform key is authorised for all
 * of them.
 *
 * So the customer is checked against the org's own stored id **after** the fetch
 * and before anything is returned, and a mismatch is reported as *not found*
 * rather than *forbidden* — "forbidden" would confirm the invoice exists.
 *
 * This is the §16 rule ("never accept `orgId` from the client") applied to a
 * foreign key space: the org comes from the session, never from the path.
 */
export async function retrieveInvoice(
  customerId: string,
  invoiceId: string,
): Promise<{ ok: true; invoice: InvoiceSummary } | StripeFailure> {
  const res = await call<StripeInvoice>(
    `/invoices/${encodeURIComponent(invoiceId)}`,
    { method: "GET" },
  );
  if (!res.ok) return res;

  const owner =
    typeof res.data.customer === "string" ? res.data.customer : (res.data.customer?.id ?? null);
  if (owner !== customerId) {
    return {
      ok: false,
      code: "unavailable",
      message: "No such invoice for this organization.",
      status: 404,
    };
  }
  const invoice = toInvoiceSummary(res.data);
  if (!invoice) return { ok: false, code: "unavailable", message: "Stripe returned an unusable invoice." };
  return { ok: true, invoice };
}

type StripeInvoice = {
  id?: string;
  customer?: string | { id?: string };
  number?: string | null;
  status?: string;
  currency?: string;
  total?: number;
  amount_paid?: number;
  amount_due?: number;
  created?: number;
  period_start?: number | null;
  period_end?: number | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  lines?: {
    data?: {
      description?: string | null;
      amount?: number;
      quantity?: number | null;
      metadata?: Record<string, string>;
    }[];
  };
};

function toInvoiceSummary(i: StripeInvoice): InvoiceSummary | null {
  if (!i.id) return null;
  return {
    id: i.id,
    number: i.number ?? null,
    status: i.status ?? "draft",
    currency: (i.currency ?? "usd").toUpperCase(),
    totalMinor: i.total ?? 0,
    amountPaidMinor: i.amount_paid ?? 0,
    amountDueMinor: i.amount_due ?? 0,
    createdAt: (secondsToDate(i.created) ?? new Date(0)).toISOString(),
    periodStart: secondsToDate(i.period_start)?.toISOString() ?? null,
    periodEnd: secondsToDate(i.period_end)?.toISOString() ?? null,
    hostedInvoiceUrl: i.hosted_invoice_url ?? null,
    invoicePdfUrl: i.invoice_pdf ?? null,
    lines: (i.lines?.data ?? []).map((l) => ({
      description: l.description ?? "",
      amountMinor: l.amount ?? 0,
      quantity: l.quantity ?? null,
      /**
       * Carried through so a threshold-fee line can be tied back to the
       * assessment that produced it — which is what makes "why this number"
       * answerable from the invoice rather than only from the ledger.
       */
      assessmentId: l.metadata?.markii_assessment_id ?? null,
    })),
  };
}

/** Markii's own invoices to this org. Distinct from `fee_assessments`, which are measurements. */
export async function listInvoices(
  customerId: string,
  limit: number,
): Promise<{ ok: true; invoices: InvoiceSummary[] } | StripeFailure> {
  /**
   * Scoped by `customer` in the query rather than filtered afterwards, so Stripe
   * never returns another merchant's invoice in the first place. The detail
   * endpoint cannot do this — it is given an id — which is why it verifies
   * ownership explicitly.
   */
  const res = await call<{ data?: StripeInvoice[] }>(
    `/invoices?customer=${encodeURIComponent(customerId)}&limit=${Math.min(Math.max(limit, 1), 100)}`,
    { method: "GET" },
  );
  if (!res.ok) return res;

  return {
    ok: true,
    invoices: (res.data.data ?? [])
      .map(toInvoiceSummary)
      .filter((i): i is InvoiceSummary => i !== null),
  };
}
