import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, stripeWebhookEvents } from "@/lib/db";
import {
  parseStripeEvent,
  verifyStripeSignature,
  type StripeEventEnvelope,
} from "@/lib/payments/stripe-webhook";

/**
 * `POST /api/webhooks/stripe` (§17) — verified, deduplicated Stripe events.
 *
 * **Two endpoints point here, and keeping them apart is the point.** Stripe
 * Connect delivers events for *merchants'* accounts as well as Markii's own, and
 * they are configured as separate endpoints with separate signing secrets. An
 * event carrying `account` belongs to a connected merchant; one without it is
 * the platform's. Confusing the two would let a merchant's `invoice.paid` mark
 * Markii's own subscription current, or the reverse (`docs/BACKEND.md`).
 *
 * **Nothing here changes billing state yet, and that is deliberate.** The
 * subscription, invoice, and payment-method routes still refuse with
 * `503 CONFIGURATION_REQUIRED` (§17), so there is nothing downstream for an
 * event to update. This endpoint verifies, records, and acknowledges — which is
 * the part that must exist *before* those land, because an event dropped while
 * the handler was missing is not redelivered later. Handlers get added to
 * `HANDLED_TYPES` as each capability is built; until then every recognised type
 * is recorded as `ignored` **with a reason**, never silently swallowed.
 *
 * Not an action (§22): there is no actor and no organization on the request.
 * Stripe is an unauthenticated caller proving itself with a signature.
 */

/**
 * Event types with a handler behind them. Empty today — see above.
 *
 * The map exists rather than a bare `if` so that "recognised but unhandled" and
 * "unrecognised" stay different states in the record. The first is a gap this
 * codebase knows about; the second is Stripe sending something nobody expected.
 */
const HANDLERS: Record<
  string,
  (event: StripeEventEnvelope) => Promise<{ detail?: string }>
> = {};

/**
 * Types this codebase intends to handle once §17's Stripe half is built. Listed
 * so an operator can see, in the table, which expected events are arriving and
 * being parked rather than having to guess from Stripe's dashboard.
 */
const EXPECTED_TYPES = new Set([
  "checkout.session.completed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "account.updated",
]);

function secretFor(hasAccount: boolean): string | undefined {
  /**
   * Connect events are signed with the connected-accounts endpoint's secret.
   * Falling back to the platform secret would be worse than failing: it would
   * make an unverifiable event look verified the moment the two secrets were
   * ever set to the same value.
   */
  return hasAccount
    ? process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    : process.env.STRIPE_WEBHOOK_SECRET;
}

export const POST = async (req: Request) => {
  /**
   * The raw body, read exactly once. `req.json()` would discard the byte
   * sequence Stripe signed — re-serialising changes whitespace and key order,
   * and the HMAC would never match again.
   */
  const raw = await req.text();

  const event = parseStripeEvent(raw);
  if (!event) {
    return NextResponse.json({ error: "Body is not a Stripe event." }, { status: 400 });
  }

  const secret = secretFor(Boolean(event.account));
  if (!secret) {
    /**
     * Configuration required, and it says which endpoint is missing. A 200 here
     * would tell Stripe the event was accepted and stop the retries, discarding
     * events for the entire window in which the secret was absent.
     */
    return NextResponse.json(
      {
        error: {
          code: "CONFIGURATION_REQUIRED",
          message: event.account
            ? "STRIPE_CONNECT_WEBHOOK_SECRET is not set; Connect events cannot be verified."
            : "STRIPE_WEBHOOK_SECRET is not set; platform events cannot be verified.",
        },
      },
      { status: 503 },
    );
  }

  const verified = verifyStripeSignature({
    payload: raw,
    header: req.headers.get("stripe-signature"),
    secret,
  });
  if (!verified.ok) {
    // 400, and nothing is recorded: an unverified payload is not evidence of
    // anything, and writing it would let anyone fill this table.
    console.warn("[stripe-webhook] rejected unverified event", verified.reason);
    return NextResponse.json({ error: verified.reason }, { status: 400 });
  }

  /**
   * Claim the event. The primary key is Stripe's own id, so a redelivery
   * collides here instead of running the handler a second time — `invoice.paid`
   * processed twice is a merchant charged twice.
   *
   * `onConflictDoNothing` rather than a read-then-write: two concurrent
   * deliveries of the same event would both pass a prior existence check.
   */
  const claimed = await db
    .insert(stripeWebhookEvents)
    .values({
      id: event.id,
      type: event.type,
      stripeAccount: event.account ?? null,
      livemode: Boolean(event.livemode),
      status: "received",
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: stripeWebhookEvents.id })
    .returning({ id: stripeWebhookEvents.id });

  if (claimed.length === 0) {
    // Already seen. Acknowledged so Stripe stops retrying, and reported as the
    // duplicate it is rather than as fresh work.
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const handler = HANDLERS[event.type];
  if (!handler) {
    const detail = EXPECTED_TYPES.has(event.type)
      ? "No handler yet — §17's Stripe half is not built (routes refuse with CONFIGURATION_REQUIRED)."
      : "Unrecognised event type; nothing in this codebase subscribes to it.";
    await db
      .update(stripeWebhookEvents)
      .set({ status: "ignored", detail, processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, event.id));
    return NextResponse.json({ ok: true, handled: false, reason: detail });
  }

  try {
    const result = await handler(event);
    await db
      .update(stripeWebhookEvents)
      .set({ status: "processed", detail: result.detail ?? null, processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, event.id));
    return NextResponse.json({ ok: true, handled: true });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "handler threw";
    await db
      .update(stripeWebhookEvents)
      .set({ status: "failed", detail, processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, event.id));

    /**
     * **500, so Stripe retries.** This is the opposite of the SES webhook, and
     * for a good reason: SNS disables a subscription after an hour of failures,
     * so dropping one bounce beats losing every future one. Stripe instead
     * retries with backoff for three days and surfaces the failure in its
     * dashboard — so a transient error here is worth another attempt, and
     * swallowing it would lose a payment event permanently.
     *
     * The row already records the failure, so the retry is visible either way.
     */
    console.error("[stripe-webhook] handler failed", event.type, detail);
    return NextResponse.json({ error: "handler failed", eventId: event.id }, { status: 500 });
  }
};
