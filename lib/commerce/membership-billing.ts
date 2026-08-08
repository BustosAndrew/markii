import "server-only";
import type { MembershipInterval } from "../db";

/**
 * Recurring memberships (§18.9) — a shopper subscribing to a **merchant's**
 * store.
 *
 * **Every call here carries `Stripe-Account`, and that is the whole point.**
 * This is the same direction of money as `lib/payments/stripe-charges.ts`: the
 * shopper pays the merchant, on the merchant's own account, into the merchant's
 * own balance. Markii takes **no `application_fee_percent`** and is never in the
 * funds flow (D4) — the same rule that governs one-off card charges, and it does
 * not relax because the payment repeats.
 *
 * It is the exact opposite of `lib/billing/stripe-billing.ts`, which never sends
 * that header because it is Markii charging the merchant. Confusing the two here
 * would subscribe a *shopper* to Markii's platform account, or bill a merchant's
 * customers for Markii's software.
 *
 * **Stripe is the scheduler.** Nothing in this deployment runs jobs — the
 * constraint that keeps membership status derived rather than stored, readiness
 * issues unstored, and the §4.5 rollup unbuilt. A renewal Markii had to fire
 * itself would therefore never fire. Handing the recurrence to Stripe puts it
 * somewhere that does have a clock, and each `invoice.paid` extends `ends_at`.
 */

const API = "https://api.stripe.com/v1";
const API_VERSION = "2025-03-31.basil";

export type MembershipBillingFailure = {
  ok: false;
  code: "configuration_required" | "unavailable";
  message: string;
  resolution?: string;
};

async function call<T>(
  accountId: string,
  path: string,
  init: { method: "GET" | "POST"; body?: URLSearchParams; idempotencyKey?: string },
): Promise<{ ok: true; data: T } | MembershipBillingFailure> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return {
      ok: false,
      code: "configuration_required",
      message: "Card payments are not available on this platform yet.",
    };
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${secret}`,
    "Stripe-Version": API_VERSION,
    /**
     * Non-negotiable. Omitting it would create the object on **Markii's**
     * platform account instead of the merchant's — a shopper's subscription
     * landing in Markii's balance, which is precisely what D4 forbids.
     */
    "Stripe-Account": accountId,
  };
  if (init.body) headers["content-type"] = "application/x-www-form-urlencoded";
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { method: init.method, headers, body: init.body?.toString() });
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
    };
  }
  return { ok: true, data: json };
}

/**
 * The shopper as a Customer on the merchant's account.
 *
 * Idempotency is keyed on the Markii customer id, so a double-submitted
 * checkout reuses one Stripe customer rather than creating two — two customers
 * means the saved card sits on the one that is not being billed.
 */
export async function ensureShopperCustomer(input: {
  accountId: string;
  customerId: number;
  existingStripeCustomerId: string | null;
  email: string;
  name: string | null;
}): Promise<{ ok: true; stripeCustomerId: string } | MembershipBillingFailure> {
  if (input.existingStripeCustomerId) {
    const existing = await call<{ id?: string; deleted?: boolean }>(
      input.accountId,
      `/customers/${encodeURIComponent(input.existingStripeCustomerId)}`,
      { method: "GET" },
    );
    if (existing.ok && existing.data.id && !existing.data.deleted) {
      return { ok: true, stripeCustomerId: existing.data.id };
    }
    // Anything other than a definite "gone" is left alone rather than replaced:
    // recreating on a transient error strands the shopper's saved card.
    if (!existing.ok) return existing;
  }

  const body = new URLSearchParams({
    email: input.email,
    "metadata[markii_customer_id]": String(input.customerId),
  });
  if (input.name) body.set("name", input.name);

  const created = await call<{ id?: string }>(input.accountId, "/customers", {
    method: "POST",
    body,
    idempotencyKey: `markii_shopper_${input.customerId}`,
  });
  if (!created.ok) return created;
  if (!created.data.id) {
    return { ok: false, code: "unavailable", message: "Stripe created no customer id." };
  }
  return { ok: true, stripeCustomerId: created.data.id };
}

/**
 * The recurring Price for a membership product, on the merchant's account.
 *
 * Created once and stored on the product. Minting a fresh Price per checkout
 * would work, but it litters the merchant's own Stripe dashboard with hundreds
 * of identical prices for one plan — and they have to live in that dashboard.
 *
 * **The amount is passed through unscaled.** It is already the currency's
 * smallest unit, which is what Stripe expects; a `/100` here would overcharge a
 * JPY shopper a hundredfold (D31).
 */
export async function createRecurringPrice(input: {
  accountId: string;
  productId: number;
  productName: string;
  amountMinor: number;
  currency: string;
  interval: Exclude<MembershipInterval, "none">;
}): Promise<{ ok: true; priceId: string } | MembershipBillingFailure> {
  const body = new URLSearchParams({
    unit_amount: String(input.amountMinor),
    currency: input.currency.toLowerCase(),
    "recurring[interval]": input.interval,
    /**
     * `product_data` rather than a pre-made product: this is the merchant's
     * catalogue item, and Stripe only needs enough to render a recognisable line
     * on the shopper's receipt and in the merchant's dashboard.
     */
    "product_data[name]": input.productName,
    "metadata[markii_product_id]": String(input.productId),
  });

  const res = await call<{ id?: string }>(input.accountId, "/prices", {
    method: "POST",
    body,
    idempotencyKey: `markii_memprice_${input.productId}_${input.interval}_${input.amountMinor}`,
  });
  if (!res.ok) return res;
  if (!res.data.id) {
    return { ok: false, code: "unavailable", message: "Stripe created no price id." };
  }
  return { ok: true, priceId: res.data.id };
}

export type MembershipSubscription = {
  subscriptionId: string;
  status: string;
  currentPeriodEnd: Date | null;
  /** Confirmed by Stripe Elements in the browser; card data never reaches Markii. */
  clientSecret: string | null;
};

/**
 * Opens the subscription.
 *
 * `payment_behavior=default_incomplete` for the same reason Markii's own
 * subscriptions use it: the subscription starts `incomplete` and becomes
 * `active` only once the first invoice is paid. **The membership is granted by
 * the `invoice.paid` webhook, never here** — granting on creation would hand a
 * shopper access before their card was charged, which is the free-goods bug in a
 * recurring costume.
 *
 * **No `application_fee_percent`.** Adding one would take a cut of a shopper's
 * payment to a merchant, which Markii does not do on any rail (D4).
 */
export async function createMembershipSubscription(input: {
  accountId: string;
  stripeCustomerId: string;
  priceId: string;
  customerId: number;
  productId: number;
}): Promise<{ ok: true; subscription: MembershipSubscription } | MembershipBillingFailure> {
  const body = new URLSearchParams({
    customer: input.stripeCustomerId,
    "items[0][price]": input.priceId,
    payment_behavior: "default_incomplete",
    "payment_settings[save_default_payment_method]": "on_subscription",
    "expand[]": "latest_invoice.confirmation_secret",
    "metadata[markii_customer_id]": String(input.customerId),
    "metadata[markii_product_id]": String(input.productId),
  });

  const res = await call<{
    id?: string;
    status?: string;
    items?: { data?: { current_period_end?: number | null }[] };
    latest_invoice?: { confirmation_secret?: { client_secret?: string } };
  }>(input.accountId, "/subscriptions", {
    method: "POST",
    body,
    /**
     * One subscription per shopper per product. A retried checkout reuses it
     * rather than opening a second — two subscriptions is a shopper charged
     * twice a month for one membership.
     */
    idempotencyKey: `markii_memsub_${input.customerId}_${input.productId}`,
  });
  if (!res.ok) return res;
  if (!res.data.id) {
    return { ok: false, code: "unavailable", message: "Stripe created no subscription id." };
  }

  const periodEnd = res.data.items?.data?.[0]?.current_period_end;
  return {
    ok: true,
    subscription: {
      subscriptionId: res.data.id,
      status: res.data.status ?? "incomplete",
      /** Period bounds live on the item since the 2025-03-31 API version. */
      currentPeriodEnd:
        typeof periodEnd === "number" && Number.isFinite(periodEnd)
          ? new Date(periodEnd * 1000)
          : null,
      clientSecret: res.data.latest_invoice?.confirmation_secret?.client_secret ?? null,
    },
  };
}

/**
 * Reads back who a subscription belongs to.
 *
 * Needed for the **first** `invoice.paid`, when no membership row exists yet:
 * checkout deliberately writes none, because there is no honest state for
 * "exists but not yet paid". The subscription's own metadata carries the link,
 * and this is how the webhook recovers it.
 *
 * The ids are returned as written and **must be re-checked against Markii's own
 * rows** by the caller. A merchant can edit metadata on their own Stripe
 * account, so treating these as authorisation would let one merchant's
 * subscription grant a membership on another's store.
 */
export async function membershipSubscriptionOwner(
  accountId: string,
  subscriptionId: string,
): Promise<
  { ok: true; customerId: number | null; productId: number | null } | MembershipBillingFailure
> {
  const res = await call<{ metadata?: Record<string, string> }>(
    accountId,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "GET" },
  );
  if (!res.ok) return res;

  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  return {
    ok: true,
    customerId: num(res.data.metadata?.markii_customer_id),
    productId: num(res.data.metadata?.markii_product_id),
  };
}

/**
 * Stops the renewal at period end.
 *
 * Never immediate. The member paid through the end of the period, and cutting
 * access short would delete time they already bought — the same rule Markii's
 * own cancellation follows. Access lapses on its own when `ends_at` passes,
 * because nothing extends it any more.
 */
export async function cancelMembershipRenewal(
  accountId: string,
  subscriptionId: string,
): Promise<{ ok: true; currentPeriodEnd: Date | null } | MembershipBillingFailure> {
  const res = await call<{ items?: { data?: { current_period_end?: number | null }[] } }>(
    accountId,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "POST", body: new URLSearchParams({ cancel_at_period_end: "true" }) },
  );
  if (!res.ok) return res;
  const periodEnd = res.data.items?.data?.[0]?.current_period_end;
  return {
    ok: true,
    currentPeriodEnd:
      typeof periodEnd === "number" && Number.isFinite(periodEnd)
        ? new Date(periodEnd * 1000)
        : null,
  };
}

/**
 * How long one billing interval is worth of access, in days.
 *
 * Deliberately generous at the boundaries (31 and 366). `ends_at` is extended
 * from whichever is later — now, or the current expiry — so a slightly long
 * grant never compounds: the next renewal simply starts from the later date.
 * Erring short would instead lapse a paying member's access for a day before
 * Stripe's next invoice arrives, which is the failure a member actually notices.
 */
export function intervalDays(interval: Exclude<MembershipInterval, "none">): number {
  return interval === "year" ? 366 : 31;
}
