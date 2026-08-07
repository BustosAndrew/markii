import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  checkoutSessions,
  db,
  integrations,
  orderEvents,
  orders,
  refunds,
  stripeWebhookEvents,
} from "@/lib/db";
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
 * **The card rail is handled; Markii's own billing state is not, and that is
 * deliberate.** Connect account state (`account.updated`,
 * `account.application.deauthorized`), payment outcomes
 * (`payment_intent.*`), and refunds (`charge.refunded`,
 * `charge.refund.updated`) all have handlers, because those are the merchant's
 * money and it is already moving. Everything about *Markii charging the
 * merchant* — subscriptions, invoices, payment methods — still refuses with
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
   * A charge on the merchant's account was refunded — **by anyone**.
   *
   * Markii's own processor refunds land here too, and they are the easy case:
   * the refund is already recorded, so this reconciles to nothing. The case this
   * handler exists for is the other one — a merchant refunding from their own
   * Stripe dashboard, which Connect Standard entitles them to do and which
   * Markii would otherwise never learn about. Their order would keep showing
   * `paid`, the threshold meter would keep counting a sale that was reversed,
   * and the stock would never come back.
   *
   * **It flags rather than fabricates.** A refund row needs to know which lines
   * were returned, whether to restock them, and how much of the money was tax
   * and shipping — none of which a Stripe charge carries, and all of which
   * `computeRefund` refuses to guess (D36: guessing there meters revenue that
   * never existed). So this writes the discrepancy onto the order timeline and
   * leaves the merchant to record it properly, which is a minute of their work
   * against a permanently wrong ledger.
   */
  "charge.refunded": async (event) => {
    const charge = event.data.object as {
      id?: string;
      payment_intent?: string;
      amount_refunded?: number;
      currency?: string;
    };
    if (!charge.payment_intent) {
      return { changed: false, detail: "Charge carries no PaymentIntent; no order to match." };
    }
    const refundedAtStripe = charge.amount_refunded ?? 0;

    return db.transaction(async (tx) => {
      /**
       * Bounded, because the lock below is held across a network call to Stripe
       * and Stripe's own webhook delivery times out around 30 seconds. Waiting
       * indefinitely would burn the delivery attempt; failing fast records the
       * event as `failed` and lets the retry — which now genuinely reprocesses,
       * see the claim logic below — arrive when the lock is long gone.
       */
      await tx.execute(sql`set local lock_timeout = '8s'`);

      /**
       * **`for update` is what makes this race-free.** Markii's own refund path
       * calls Stripe while holding this exact lock and commits straight after,
       * so the event can easily arrive before the refund row exists. Reading
       * without the lock would see a stale `refundedMinor` and report the
       * platform's own refund as one issued behind its back.
       */
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.paymentReference, charge.payment_intent!))
        .limit(1)
        .for("update");
      if (!order) {
        return { changed: false, detail: `No order for PaymentIntent ${charge.payment_intent}.` };
      }

      if (refundedAtStripe <= order.refundedMinor) {
        return {
          changed: false,
          detail:
            `Stripe reports ${refundedAtStripe} refunded on order ${order.id}; Markii already ` +
            `has ${order.refundedMinor}. Nothing to reconcile.`,
        };
      }

      const gap = refundedAtStripe - order.refundedMinor;
      const currency = (charge.currency ?? order.currency).toUpperCase();
      await tx.insert(orderEvents).values({
        orderId: order.id,
        type: "note",
        message:
          `Stripe reports ${refundedAtStripe} ${currency} refunded on this order, but Markii has ` +
          `only ${order.refundedMinor} recorded — ${gap} ${currency} was refunded outside Markii. ` +
          "Record it here so the stock, the customer's downloads, and your threshold meter match " +
          "the money.",
        data: {
          source: "stripe_webhook",
          chargeId: charge.id ?? null,
          paymentIntentId: charge.payment_intent,
          amountRefundedAtStripe: refundedAtStripe,
          amountRefundedInMarkii: order.refundedMinor,
          unrecordedMinor: gap,
          currency,
        },
        visibility: "internal",
        actorType: "system",
      });

      return {
        detail: `Flagged ${gap} ${currency} refunded outside Markii on order ${order.id}.`,
      };
    });
  },

  /**
   * A refund changed state after it was created — in practice, one that was
   * `pending` and has now `failed`.
   *
   * This is the other half of accepting `pending` when the refund was issued
   * (`lib/payments/stripe-refunds.ts`). Refusing pending refunds would leave
   * money moving at Stripe with nothing recorded here; accepting them means
   * committing to hear about the small number that never land.
   *
   * **It does not reverse the refund row.** Un-refunding means re-taking stock
   * from a shopper, re-metering the sale, and reinstating downloads that were
   * revoked — a judgement about a real customer, which `orders.refund` already
   * declines to automate (`undoable: false`). The timeline says what happened
   * and the merchant decides.
   */
  "charge.refund.updated": async (event) => {
    const refund = event.data.object as {
      id?: string;
      status?: string;
      failure_reason?: string;
      amount?: number;
    };
    if (!refund.id) return { changed: false, detail: "Event carried no refund id." };
    if (refund.status === "succeeded" || refund.status === "pending") {
      return { changed: false, detail: `Refund ${refund.id} is "${refund.status}"; nothing wrong.` };
    }

    const [row] = await db
      .select({ id: refunds.id, orderId: refunds.orderId, amountMinor: refunds.amountMinor })
      .from(refunds)
      .where(eq(refunds.processorReference, refund.id))
      .limit(1);
    if (!row) {
      return { changed: false, detail: `No Markii refund recorded against ${refund.id}.` };
    }

    await db.insert(orderEvents).values({
      orderId: row.orderId,
      type: "note",
      message:
        `Stripe refund ${refund.id} is now "${refund.status}"` +
        (refund.failure_reason ? ` (${refund.failure_reason})` : "") +
        `. The ${row.amountMinor} recorded as refund ${row.id} did not reach the customer. ` +
        "The refund is still recorded here — stock was returned and access revoked — so decide " +
        "whether to reissue it or reverse the record.",
      data: {
        source: "stripe_webhook",
        refundId: row.id,
        processorRefundId: refund.id,
        status: refund.status ?? null,
        failureReason: refund.failure_reason ?? null,
      },
      visibility: "internal",
      actorType: "system",
    });
    return { detail: `Flagged failed Stripe refund ${refund.id} on order ${row.orderId}.` };
  },

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
  "charge.refunded",
  "charge.refund.updated",
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
    /**
     * Already claimed — but *claimed* is not *done*, and the difference is what
     * makes the 500-so-Stripe-retries path below actually work.
     *
     * The row is written before the handler runs, so a handler that throws
     * leaves a `failed` row behind. Treating every collision as a duplicate
     * would make the retry a no-op and quietly discard the event the retry
     * existed to deliver — the 500 would look like it asked for another attempt
     * and then refuse it.
     *
     * So a `failed` row is reprocessed and anything else is a genuine
     * redelivery. Handlers are idempotent (`completeCheckout` returns the
     * existing order, the integration writes are upserts, and the refund
     * handlers do their reads and writes in one transaction), so a second run
     * of one that failed part-way is safe.
     */
    const [seen] = await db
      .select({ status: stripeWebhookEvents.status })
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.id, event.id))
      .limit(1);
    if (seen?.status !== "failed") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
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
