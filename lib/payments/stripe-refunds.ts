import "server-only";

/**
 * Card refunds via Stripe Connect Standard (§18.7).
 *
 * **The refund is created on the merchant's own account**, with
 * `Stripe-Account: acct_…`, because that is where the direct charge lives. The
 * money comes out of the merchant's balance and goes back to their shopper;
 * Markii is no more in the funds flow reversing a payment than it was taking one
 * (`docs/DECISIONS.md` D4).
 *
 * **No `refund_application_fee`, no `reverse_transfer`.** Both parameters exist
 * for platforms that took a cut, and Markii never does — there is nothing to give
 * back. Their absence here is the same decision as the absent
 * `application_fee_amount` in `stripe-charges.ts`, seen from the other end.
 *
 * Hand-rolled over `fetch`, like the charge, OAuth, and webhook-signature code.
 */

const REFUNDS = "https://api.stripe.com/v1/refunds";

/**
 * Stripe accepts **three** refund reasons; Markii records five (§18.7).
 *
 * The extra two are dropped rather than coerced. Sending `item_unavailable` is a
 * 400 from Stripe, and mapping it onto `requested_by_customer` would write a
 * reason into the merchant's own Stripe dashboard that nobody chose — a small
 * fabrication, but in the record they will read during a chargeback. The real
 * reason goes to metadata instead, where it is visible and unambiguous.
 */
const STRIPE_REASONS = new Set(["duplicate", "fraudulent", "requested_by_customer"]);

export type StripeRefundResult =
  | {
      ok: true;
      refundId: string;
      /** Stripe's own status: `succeeded` or `pending` — see `accepted` below. */
      status: string;
      amountMinor: number;
      currency: string;
    }
  | { ok: false; reason: string };

/**
 * Issues a refund against a PaymentIntent on a connected account.
 *
 * `amountMinor` is passed through **unscaled**, exactly as the charge was: Stripe
 * wants the currency's smallest unit and that is what this codebase stores. A
 * `/100` here would refund a JPY shopper one hundredth of what they paid (D31).
 */
export async function createStripeRefund(input: {
  accountId: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  /**
   * Stable across a retry of the *same* refund, different for a genuinely new
   * one — see `refundIdempotencyKey`. This is the whole protection against a
   * shopper being paid back twice.
   */
  idempotencyKey: string;
  orderId: number;
}): Promise<StripeRefundResult> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return { ok: false, reason: "Markii has no Stripe credentials configured." };

  const body = new URLSearchParams({
    payment_intent: input.paymentIntentId,
    /**
     * Always explicit, even for a full refund. Omitting it tells Stripe to
     * refund the whole intent, which would quietly turn a partial refund into a
     * full one if the amount were ever computed as the order total.
     */
    amount: String(input.amountMinor),
    "metadata[markii_order_id]": String(input.orderId),
    "metadata[markii_reason]": input.reason,
  });
  if (STRIPE_REASONS.has(input.reason)) body.set("reason", input.reason);

  let res: Response;
  try {
    res = await fetch(REFUNDS, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${secret}`,
        /** The charge belongs to the merchant, so the reversal does too. */
        "Stripe-Account": input.accountId,
        "Idempotency-Key": input.idempotencyKey,
      },
      body: body.toString(),
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not reach Stripe." };
  }

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    amount?: number;
    currency?: string;
    error?: { message?: string; code?: string };
  };

  if (!res.ok || !json.id || !json.status) {
    // Stripe's own wording. "Charge has already been refunded" and "insufficient
    // funds in your Stripe balance" need completely different actions from a
    // merchant, and a generic failure hides which one they are looking at.
    return { ok: false, reason: json.error?.message ?? `Stripe returned ${res.status}.` };
  }

  /**
   * A refund that Stripe reports as `failed` or `canceled` moved no money. It
   * must not become a refund row: the order would show the shopper repaid,
   * the meter would be credited, and stock would go back for a reversal that
   * never happened.
   */
  if (!accepted(json.status)) {
    return { ok: false, reason: `Stripe refund ${json.id} came back "${json.status}".` };
  }

  /**
   * Defensive, and cheap. Stripe echoing a different amount or currency than
   * was asked would mean the refund row and the money disagree — which is the
   * one thing a financial record may never do.
   */
  if (typeof json.amount === "number" && json.amount !== input.amountMinor) {
    return {
      ok: false,
      reason: `Stripe refunded ${json.amount} but ${input.amountMinor} was requested.`,
    };
  }
  const currency = (json.currency ?? input.currency).toUpperCase();
  if (currency !== input.currency.toUpperCase()) {
    return { ok: false, reason: `Stripe refunded in ${currency}, not ${input.currency}.` };
  }

  return {
    ok: true,
    refundId: json.id,
    status: json.status,
    amountMinor: json.amount ?? input.amountMinor,
    currency,
  };
}

/**
 * Statuses that mean the money is committed to going back.
 *
 * `pending` counts. A card refund is usually `succeeded` at once, but some
 * methods settle asynchronously, and refusing those would leave money moving at
 * Stripe with nothing recorded here — strictly worse than recording it and
 * saying it is pending, which the order timeline does.
 *
 * `requires_action` deliberately does not count: it means the shopper still has
 * to do something, so nothing is committed yet.
 */
export function accepted(status: string): boolean {
  return status === "succeeded" || status === "pending";
}

/**
 * The idempotency key, derived from the refund itself rather than from the
 * request that asked for it.
 *
 * A key that changed per attempt would protect nothing: the failure worth
 * guarding against is a Stripe call that succeeds and a transaction that then
 * fails to commit, where the natural response is to retry the same refund.
 *
 * Keying on `(order, what was already refunded, amount)` makes exactly that
 * retry collide with itself — Stripe returns the original refund instead of
 * issuing a second one — while a genuinely new partial refund, which by
 * definition happens after `refundedBeforeMinor` has moved, gets its own key.
 */
export function refundIdempotencyKey(
  orderId: number,
  refundedBeforeMinor: number,
  amountMinor: number,
): string {
  return `markii_refund_${orderId}_${refundedBeforeMinor}_${amountMinor}`;
}
