import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { checkoutSessions, db, integrations, stripeWebhookEvents } from "@/lib/db";
import { completeCheckout, failCheckout } from "@/lib/commerce/orders";
import { upsertIntegration } from "@/lib/integrations";
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
 * **Connect account state is handled; billing state is not, and that is
 * deliberate.** `account.updated` and `account.application.deauthorized` keep a
 * merchant's card-rail eligibility current, because those need nothing from
 * Stripe's API beyond the event itself. Everything about *charging* —
 * subscriptions, invoices, payment methods — still refuses with
 * `503 CONFIGURATION_REQUIRED` (§17), so there is nothing downstream for those
 * events to update yet. Handlers get added to `HANDLERS` as each capability is
 * built; until then every recognised type is recorded as `ignored` **with a
 * reason**, never silently swallowed, because an event dropped while its handler
 * was missing is not redelivered later.
 *
 * Not an action (§22): there is no actor and no organization on the request.
 * Stripe is an unauthenticated caller proving itself with a signature.
 */

/**
 * Event types with a handler behind them.
 *
 * The map exists rather than a bare `if` so that "recognised but unhandled" and
 * "unrecognised" stay different states in the record. The first is a gap this
 * codebase knows about; the second is Stripe sending something nobody expected.
 */
type HandlerResult = {
  detail?: string;
  /**
   * `false` when the handler ran but **changed nothing** — an event for an
   * account this deployment does not know, say. Recorded as `ignored` rather
   * than `processed`, because this table exists to answer "what did Stripe send
   * and what did we do about it", and logging a no-op as processed misleads
   * whoever reads it during a billing dispute.
   */
  changed?: boolean;
};

const HANDLERS: Record<string, (event: StripeEventEnvelope) => Promise<HandlerResult>> = {
  /**
   * The merchant's Connect account changed — verification completed, a
   * capability granted or revoked, new requirements raised.
   *
   * **`charges_enabled` is the only honest gate for offering the card rail.** An
   * account can be connected and still unable to take payments while Stripe
   * waits on documents, and a storefront that offers card checkout in that
   * window fails the shopper at the moment they enter their card.
   */
  "account.updated": async (event) => {
    const account = event.data.object as {
      id?: string;
      charges_enabled?: boolean;
      payouts_enabled?: boolean;
      requirements?: { currently_due?: string[] };
    };
    const accountId = event.account ?? account.id;
    if (!accountId) {
      return { changed: false, detail: "Event carried no account id; nothing to update." };
    }

    const row = await integrationForAccount(accountId);
    if (!row) {
      /**
       * Not an error. Stripe sends events for every account connected to the
       * platform, including ones this deployment does not know about — a
       * connection made against a different environment, or one already
       * removed. Recording that is more useful than failing and retrying for
       * three days over an account nobody here owns.
       */
      return { changed: false, detail: `No connected account ${accountId} in this deployment.` };
    }

    await upsertIntegration(
      row.orgId,
      "stripe",
      "connected",
      {
        ...row.config,
        accountId,
        chargesEnabled: String(Boolean(account.charges_enabled)),
        payoutsEnabled: String(Boolean(account.payouts_enabled)),
        requirementsDue: (account.requirements?.currently_due ?? []).join(","),
      },
      account.charges_enabled
        ? null
        : "Stripe has not enabled charges on this account yet — card checkout stays off until it does.",
    );
    return {
      detail: `charges_enabled=${Boolean(account.charges_enabled)} payouts_enabled=${Boolean(
        account.payouts_enabled,
      )}`,
    };
  },

  /**
   * The card payment succeeded. **This is the authoritative completion signal.**
   *
   * The shopper's browser also posts to `/complete`, but a browser can be closed
   * mid-redirect and its word is not evidence anyway. Stripe telling us is what
   * guarantees an order exists for money that moved. Both paths call the same
   * idempotent `completeCheckout`, so whichever arrives second returns the
   * existing order rather than creating a second one.
   */
  "payment_intent.succeeded": async (event) => {
    const intent = event.data.object as { id?: string; amount?: number };
    if (!intent.id) return { changed: false, detail: "Event carried no PaymentIntent id." };

    const [session] = await db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.paymentReference, intent.id))
      .limit(1);
    if (!session) {
      return { changed: false, detail: `No checkout session for ${intent.id}.` };
    }
    if (session.status === "completed" && session.orderId != null) {
      return { changed: false, detail: `Session ${session.id} was already completed.` };
    }

    /**
     * The amount is re-checked against the frozen quote. A PaymentIntent can be
     * updated after it is created, and paying less than the basket costs must
     * not release the goods.
     */
    if (typeof intent.amount === "number" && intent.amount !== session.totalMinor) {
      return {
        changed: false,
        detail: `Amount ${intent.amount} does not match session total ${session.totalMinor}; not completed.`,
      };
    }

    const done = await completeCheckout({
      session,
      paymentReference: intent.id,
      payerReference: null,
    });
    return { detail: `Completed session ${session.id} as order ${done.orderId}.` };
  },

  /**
   * The payment failed or was abandoned. **Release the stock.**
   *
   * A reservation held for a card that declined is the last unit of someone
   * else's order sitting idle until the sweep catches it. The sweep is a
   * backstop, not the mechanism.
   */
  "payment_intent.payment_failed": releaseIntent,
  "payment_intent.canceled": releaseIntent,

  /**
   * The merchant revoked Markii's access from their own Stripe dashboard.
   *
   * **This has to turn the card rail off immediately.** Markii cannot create
   * charges on that account any more, so a storefront still offering card
   * checkout would take a shopper to a payment that cannot succeed. Under
   * Connect Standard the merchant can do this at any time without telling us,
   * which is precisely why the webhook is the only way to find out.
   */
  "account.application.deauthorized": async (event) => {
    const accountId = event.account ?? (event.data.object as { id?: string }).id;
    if (!accountId) {
      return { changed: false, detail: "Event carried no account id; nothing to disconnect." };
    }

    const row = await integrationForAccount(accountId);
    if (!row) {
      return { changed: false, detail: `No connected account ${accountId} in this deployment.` };
    }

    /**
     * The account id is kept rather than cleared. It is not a credential, and a
     * merchant who reconnects the same account should be recognisable — while
     * `chargesEnabled: false` is what actually gates the rail.
     */
    await upsertIntegration(
      row.orgId,
      "stripe",
      "not_connected",
      {
        ...row.config,
        accountId,
        chargesEnabled: "false",
        payoutsEnabled: "false",
      },
      "This Stripe account was disconnected from Markii in the Stripe dashboard.",
    );
    return { detail: `Disconnected ${accountId}; card rail is off for org ${row.orgId}.` };
  },
};

/** Shared by the failure and cancellation events, which differ only in wording. */
async function releaseIntent(event: StripeEventEnvelope): Promise<HandlerResult> {
  const intent = event.data.object as { id?: string };
  if (!intent.id) return { changed: false, detail: "Event carried no PaymentIntent id." };

  const [session] = await db
    .select()
    .from(checkoutSessions)
    .where(eq(checkoutSessions.paymentReference, intent.id))
    .limit(1);
  if (!session) return { changed: false, detail: `No checkout session for ${intent.id}.` };
  if (session.status === "completed") {
    /**
     * A late failure event for a checkout that already completed must not
     * release stock the buyer has paid for.
     */
    return { changed: false, detail: `Session ${session.id} already completed; stock kept.` };
  }

  await failCheckout(session.id, `Stripe reported ${event.type}`);
  return { detail: `Released the reservation for session ${session.id}.` };
}

/**
 * Finds which org a Connect event belongs to.
 *
 * The webhook is unauthenticated and carries no session, so the connected
 * account id is the **only** link back to a tenant — and it is matched against
 * stored connections rather than trusted as an org identifier, so an event for
 * an unknown account resolves to nothing instead of to somebody.
 */
async function integrationForAccount(accountId: string) {
  const [row] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, "stripe"),
        sql`${integrations.config} ->> 'accountId' = ${accountId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Types this codebase intends to handle once §17's Stripe half is built. Listed
 * so an operator can see, in the table, which expected events are arriving and
 * being parked rather than having to guess from Stripe's dashboard.
 */
const EXPECTED_TYPES = new Set([
  "checkout.session.completed",
  "charge.refunded",
  "charge.dispute.created",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.created",
  "invoice.finalized",
  "customer.subscription.trial_will_end",
  "payment_method.attached",
  "payment_method.detached",
  /** Handled today — listed so the expected/unexpected split stays complete. */
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "account.updated",
  "account.application.deauthorized",
  "charge.dispute.closed",
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
    const changed = result.changed !== false;
    await db
      .update(stripeWebhookEvents)
      .set({
        status: changed ? "processed" : "ignored",
        /** `ignored` must carry a reason — the database enforces it too. */
        detail: result.detail ?? (changed ? null : "Handler made no change."),
        processedAt: new Date(),
      })
      .where(eq(stripeWebhookEvents.id, event.id));
    return NextResponse.json({
      ok: true,
      handled: changed,
      ...(changed ? {} : { reason: result.detail ?? "Handler made no change." }),
    });
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
