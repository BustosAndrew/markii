import "server-only";

/**
 * Card charges via Stripe Connect Standard (§18.4).
 *
 * **Direct charges on the merchant's own account.** The PaymentIntent is created
 * with `Stripe-Account: acct_…`, so the charge belongs to the merchant, settles
 * into their balance, and pays out to their bank. Markii is never in the funds
 * flow (`docs/PLAN.md` §3).
 *
 * **No `application_fee_amount`, ever** (D4). Markii's revenue is the
 * subscription and the threshold fee, billed on Markii's own invoice — it never
 * touches a merchant's payment. Adding a fee parameter here would silently
 * falsify the public claim that merchants keep their own rates, and would make
 * Markii a party to the money.
 *
 * Hand-rolled over `fetch`, like the OAuth and webhook-signature code. The
 * surface is one call; the SDK's value is in the parts of Stripe this codebase
 * does not touch.
 */

import { matchedPublishableKey } from "../stripe-mode";

const PAYMENT_INTENTS = "https://api.stripe.com/v1/payment_intents";

export type ChargeStart =
  | { ok: true; paymentIntentId: string; clientSecret: string; publishableKey: string | null }
  | { ok: false; reason: string };

/**
 * Opens a PaymentIntent for a checkout.
 *
 * `amountMinor` is passed through **unscaled**. Stripe expects the currency's
 * smallest unit, which is exactly what the rest of this codebase stores, so
 * there is no conversion here and must never be one — a `/100` would overcharge
 * a JPY shopper a hundredfold (D31).
 */
export async function createPaymentIntent(input: {
  accountId: string;
  amountMinor: number;
  currency: string;
  /** The checkout session this pays for. Doubles as the idempotency key. */
  sessionId: string;
  siteId: number;
  email: string | null;
}): Promise<ChargeStart> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return { ok: false, reason: "Markii has no Stripe credentials configured." };

  const body = new URLSearchParams({
    amount: String(input.amountMinor),
    currency: input.currency.toLowerCase(),
    /** Lets the merchant's own Stripe settings decide which methods are offered. */
    "automatic_payment_methods[enabled]": "true",
    /**
     * The link back from a Stripe event to a Markii checkout. The webhook also
     * matches on `checkout_sessions.payment_reference`; metadata is what makes
     * the connection legible from the *merchant's* Stripe dashboard, where they
     * will be looking when they ask why a payment exists.
     */
    "metadata[markii_session_id]": input.sessionId,
    "metadata[markii_site_id]": String(input.siteId),
  });
  if (input.email) body.set("receipt_email", input.email);

  let res: Response;
  try {
    res = await fetch(PAYMENT_INTENTS, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${secret}`,
        /** Direct charge: this belongs to the merchant, not to Markii. */
        "Stripe-Account": input.accountId,
        /**
         * Keyed on the checkout session, so a retried session creation reuses
         * the same PaymentIntent instead of opening a second one. Two intents
         * for one basket is two authorisations on a shopper's card.
         */
        "Idempotency-Key": `markii_checkout_${input.sessionId}`,
      },
      body: body.toString(),
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not reach Stripe." };
  }

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    client_secret?: string;
    error?: { message?: string; code?: string };
  };

  if (!res.ok || !json.id || !json.client_secret) {
    // Stripe's own wording. "Your account cannot currently make live charges"
    // is actionable; a generic failure is not.
    return {
      ok: false,
      reason: json.error?.message ?? `Stripe returned ${res.status}.`,
    };
  }

  return {
    ok: true,
    paymentIntentId: json.id,
    clientSecret: json.client_secret,
    /**
     * Needed by Stripe-hosted Elements in the browser, which is the only place
     * card details may ever go (PCI SAQ-A). Null is a real state — the rail is
     * unusable without it, and saying so beats rendering an empty card form.
     *
     * **Null also covers a key from the other mode**, which is the more
     * dangerous case because it looks configured. A `pk_live_` cannot confirm a
     * PaymentIntent opened by an `sk_test_`, so the shopper's card would be
     * rejected by Stripe *after* stock was reserved for them — see
     * `lib/stripe-mode.ts`.
     */
    publishableKey: matchedPublishableKey(),
  };
}

export type IntentStatus = {
  ok: true;
  status: string;
  amountMinor: number;
  currency: string;
  /** True only for `succeeded` — the one status that means money moved. */
  paid: boolean;
} | { ok: false; reason: string };

/**
 * Reads a PaymentIntent back from Stripe.
 *
 * **Completion never trusts the caller.** A browser posting "it worked" is a
 * free-goods bug, exactly as it would be on the x402 rail where the transaction
 * hash is verified on-chain. The authority for whether money moved is Stripe,
 * and this is how we ask.
 *
 * Read against the **connected account**, because that is where a direct charge
 * lives — retrieving it with the platform key alone finds nothing.
 */
export async function retrievePaymentIntent(
  accountId: string,
  paymentIntentId: string,
): Promise<IntentStatus> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return { ok: false, reason: "Markii has no Stripe credentials configured." };

  try {
    const res = await fetch(`${PAYMENT_INTENTS}/${encodeURIComponent(paymentIntentId)}`, {
      headers: { authorization: `Bearer ${secret}`, "Stripe-Account": accountId },
    });
    const json = (await res.json().catch(() => ({}))) as {
      status?: string;
      amount?: number;
      currency?: string;
      error?: { message?: string };
    };
    if (!res.ok || !json.status) {
      return { ok: false, reason: json.error?.message ?? `Stripe returned ${res.status}.` };
    }
    return {
      ok: true,
      status: json.status,
      amountMinor: json.amount ?? 0,
      currency: (json.currency ?? "").toUpperCase(),
      paid: json.status === "succeeded",
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not reach Stripe." };
  }
}
