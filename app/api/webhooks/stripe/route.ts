import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  checkoutSessions,
  db,
  integrations,
  orderEvents,
  orders,
  organizations,
  refunds,
  stripeWebhookEvents,
} from "@/lib/db";
import { completeCheckout, failCheckout, recordUsage } from "@/lib/commerce/orders";
import {
  extendRenewedMembership,
  grantSubscriptionMembership,
} from "@/lib/commerce/memberships";
import { membershipSubscriptionOwner } from "@/lib/commerce/membership-billing";
import { mirrorCancellation, mirrorSubscription } from "@/lib/billing/mirror";
import { retrieveSubscription, toSnapshot } from "@/lib/billing/stripe-billing";
import { upsertIntegration } from "@/lib/integrations";
import {
  diagnoseSignatureFailure,
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
 * **Both directions of money are now handled, and they are handled apart.** The
 * merchant's money — Connect account state (`account.updated`,
 * `account.application.deauthorized`), payment outcomes (`payment_intent.*`),
 * and refunds (`charge.refunded`, `charge.refund.updated`) — moves on the
 * merchant's own account. Markii's money — `customer.subscription.*`,
 * `invoice.paid`, `invoice.payment_failed` — moves on the platform account and
 * decides what the merchant is entitled to.
 *
 * The billing handlers call `platformOnly` before doing anything, because the
 * separation is semantic as well as cryptographic: a *merchant's* customers
 * subscribing to a *merchant's* products emits the same event types, and acting
 * on one would let a merchant rewrite their own Markii entitlements from an
 * account they control.
 *
 * Handlers get added to `HANDLERS` as each capability is built; anything
 * recognised but unhandled is recorded as `ignored` **with a reason**, never
 * silently swallowed, because an event dropped while its handler was missing is
 * not redelivered later.
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
   * **Markii's own subscription changed.** Platform events only — a merchant's
   * account never sends these, and `platformOnly` refuses one that claims to.
   *
   * This is the **authoritative** signal for what a merchant is entitled to, in
   * exactly the way `payment_intent.succeeded` is authoritative for a shopper's
   * order. The `billing.changePlan` action writes the same mirror optimistically
   * from Stripe's API response, but its transaction can roll back after Stripe
   * has already changed, and a merchant can also cancel or upgrade from Stripe's
   * own billing portal where Markii is never in the loop. Both paths run through
   * `mirrorSubscription`, so the reconciliation cannot reach a different answer
   * than the action would have.
   */
  "customer.subscription.created": subscriptionChanged,
  "customer.subscription.updated": subscriptionChanged,

  /**
   * The subscription is gone — the period ended after a cancellation, or Stripe
   * gave up dunning it.
   *
   * Handled separately from an update because the object no longer exists:
   * keeping its id would leave the org pointing at something Stripe 404s on, and
   * the next plan change would try to modify it instead of creating a new one.
   * Entitlements drop to the floor plan here, and this is the **only** place a
   * merchant loses access — never at the moment they click cancel.
   */
  "customer.subscription.deleted": async (event) => {
    /**
     * On a connected account this is a *shopper's* membership subscription
     * ending, not Markii's billing. It revokes nothing: `ends_at` already covers
     * the period they paid for and status is derived from it, so access lapses
     * on its own once nothing extends it. Ending it here would delete time the
     * member had bought.
     */
    if (event.account) {
      return {
        changed: false,
        detail:
          "Shopper membership subscription ended on a connected account. Access runs to ends_at " +
          "and lapses on its own (§18.9); nothing to revoke.",
      };
    }

    const sub = event.data.object as { id?: string; customer?: string };
    if (!sub.id) return { changed: false, detail: "Event carried no subscription id." };

    const orgId = await orgForSubscription(sub.id, sub.customer);
    if (!orgId) return { changed: false, detail: `No organization for subscription ${sub.id}.` };

    const result = await mirrorCancellation(db, orgId, sub.id);
    if ("stale" in result) return { changed: false, detail: result.reason };
    return {
      detail: `Subscription ${sub.id} deleted; ${orgId} dropped to ${result.planId}.`,
      changed: result.planChanged,
    };
  },

  /**
   * A subscription invoice was paid. **The moment an `incomplete` signup becomes
   * a paying customer.**
   *
   * The subscription is re-read from Stripe rather than trusted from the invoice
   * body: the invoice says money arrived, but what the org is *entitled* to comes
   * from the subscription's price, and reading it back is what keeps one
   * derivation of that instead of two.
   */
  "invoice.paid": invoiceSettled,

  /**
   * A subscription payment failed. Recorded, but **entitlements do not move
   * here.**
   *
   * Stripe retries over days, and `customer.subscription.updated` reports the
   * status change (`past_due`, then `unpaid` if it gives up) as it happens.
   * Revoking on this event would take a working storefront offline over a card
   * that is usually about to succeed, and would then disagree with the status
   * the subscription itself carries.
   */
  "invoice.payment_failed": invoiceSettled,

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
/**
 * Refuses a billing event that arrived carrying a connected account.
 *
 * Markii's own subscriptions live on the **platform** account. An event with
 * `account` set is a *merchant's* — their own customers' subscriptions to their
 * own products, which have nothing to do with what they owe Markii. Acting on
 * one would let a merchant's billing activity rewrite their Markii entitlements,
 * and a merchant controls their own Stripe account.
 *
 * The signing secrets already separate the two endpoints; this is the second
 * lock, on the semantics rather than the transport.
 */
function platformOnly(event: StripeEventEnvelope): HandlerResult | null {
  return event.account
    ? {
        changed: false,
        detail:
          `Subscription lifecycle event on connected account ${event.account} changes no Markii ` +
          "billing state. A shopper's recurring membership is granted by invoice.paid (§18.9), " +
          "not by the subscription being created or updated — a subscription exists before its " +
          "first invoice is paid.",
      }
    : null;
}

/** Shared by `customer.subscription.created` and `.updated` — same mirror, same guard. */
async function subscriptionChanged(event: StripeEventEnvelope): Promise<HandlerResult> {
  const guard = platformOnly(event);
  if (guard) return guard;

  const snapshot = toSnapshot(event.data.object as Parameters<typeof toSnapshot>[0]);
  if (!snapshot) return { changed: false, detail: "Event carried an unusable subscription." };

  const orgId = await orgForSubscription(snapshot.subscriptionId, snapshot.customerId);
  if (!orgId) {
    /**
     * Not an error. Stripe sends events for every subscription on the platform
     * account, including ones created against a different environment sharing
     * the same Stripe account, or an org since deleted.
     */
    return {
      changed: false,
      detail: `No organization for subscription ${snapshot.subscriptionId}.`,
    };
  }

  const result = await mirrorSubscription(db, orgId, snapshot, { guardAgainstStale: true });
  if ("stale" in result) return { changed: false, detail: result.reason };
  return {
    detail:
      `Subscription ${snapshot.subscriptionId} is ${result.status}; ` +
      `${orgId} on ${result.planId}${result.planChanged ? " (changed)" : ""}.`,
  };
}

/**
 * `invoice.paid` / `invoice.payment_failed` — re-read the subscription and
 * mirror it.
 *
 * The invoice says what happened to the money; the subscription says what the
 * merchant is entitled to. Deriving entitlements from the invoice would be a
 * second derivation to keep in step with the first.
 */
async function invoiceSettled(event: StripeEventEnvelope): Promise<HandlerResult> {
  /**
   * **The same event type means opposite things on the two endpoints.** On the
   * platform account it is Markii billing a merchant; on a connected account it
   * is a *shopper* paying a *merchant* for a recurring membership (§18.9).
   * Forking on `account` is what keeps a merchant's own customers from touching
   * Markii's billing state, and vice versa.
   */
  if (event.account) return membershipRenewed(event);

  const invoice = event.data.object as {
    id?: string;
    customer?: string;
    subscription?: string | { id?: string };
    parent?: { subscription_details?: { subscription?: string | { id?: string } } };
  };

  /**
   * `invoice.subscription` moved under `parent.subscription_details` in the
   * 2025-03-31 API version this codebase pins. Reading only the old field would
   * make every invoice look like a one-off and silently stop reconciling.
   */
  const raw =
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription ?? null;
  const subscriptionId = typeof raw === "string" ? raw : (raw?.id ?? null);
  if (!subscriptionId) {
    return { changed: false, detail: `Invoice ${invoice.id ?? "?"} is not for a subscription.` };
  }

  const orgId = await orgForSubscription(subscriptionId, invoice.customer);
  if (!orgId) {
    return { changed: false, detail: `No organization for subscription ${subscriptionId}.` };
  }

  const fresh = await retrieveSubscription(subscriptionId);
  if (!fresh.ok) {
    /**
     * Thrown, not swallowed: this is the event that flips a paid signup to
     * active, and losing it leaves a merchant who has been charged sitting on
     * the floor plan. A 500 puts it back in Stripe's three-day retry window.
     */
    throw new Error(`Could not read subscription ${subscriptionId}: ${fresh.message}`);
  }

  const result = await mirrorSubscription(db, orgId, fresh.snapshot, { guardAgainstStale: true });
  if ("stale" in result) return { changed: false, detail: result.reason };
  return {
    detail: `${event.type} for ${subscriptionId}: ${orgId} is ${result.status} on ${result.planId}.`,
    changed: result.planChanged || event.type === "invoice.paid",
  };
}

/**
 * A shopper's recurring membership was paid for (§18.9) — **the only thing that
 * grants recurring access.**
 *
 * Not subscription creation, deliberately: a subscription exists in
 * `incomplete` before its first invoice is paid, so granting there would hand a
 * shopper access before their card was charged. This is the same rule
 * `payment_intent.succeeded` follows for one-off orders — Stripe saying money
 * moved is the authority, and nothing else is.
 *
 * `invoice.payment_failed` deliberately does **nothing**: `ends_at` already
 * covers the period the member paid for, status is derived from it, and Stripe
 * retries for days. Access lapses on its own if the retries never succeed, which
 * is both correct and kinder than revoking on a first decline.
 */
async function membershipRenewed(event: StripeEventEnvelope): Promise<HandlerResult> {
  if (event.type !== "invoice.paid") {
    return {
      changed: false,
      detail:
        `${event.type} on a connected account changes no membership — access already runs to ` +
        "ends_at, and Stripe retries a failed payment for days.",
    };
  }

  const invoice = event.data.object as {
    id?: string;
    subscription?: string | { id?: string };
    parent?: { subscription_details?: { subscription?: string | { id?: string } } };
    lines?: { data?: { period?: { start?: number; end?: number } }[] };
    currency?: string;
    subtotal?: number;
    total_excluding_tax?: number | null;
    amount_paid?: number;
  };

  const raw = invoice.parent?.subscription_details?.subscription ?? invoice.subscription ?? null;
  const subscriptionId = typeof raw === "string" ? raw : (raw?.id ?? null);
  if (!subscriptionId || !invoice.id) {
    return { changed: false, detail: "Connected-account invoice is not for a subscription." };
  }

  /**
   * The period Stripe actually billed, rather than a nominal 31 or 366 days.
   * Using Stripe's own bounds keeps `ends_at` in step with what the shopper was
   * charged for, including a proration or a trial that made this period an
   * unusual length.
   */
  const period = invoice.lines?.data?.[0]?.period;
  const days =
    period?.start && period?.end && period.end > period.start
      ? Math.max(1, Math.round((period.end - period.start) / 86_400))
      : 31;

  let result = await extendRenewedMembership(db, {
    subscriptionId,
    days,
    invoiceId: invoice.id,
  });

  /**
   * **First payment.** Checkout writes no membership row — there is no honest
   * state for "exists but not yet paid" — so the first invoice is what creates
   * it, resolved from the subscription's metadata. `grantSubscriptionMembership`
   * re-checks those ids against Markii's own rows rather than trusting them: a
   * merchant controls the metadata on their own account.
   */
  if (!result.ok && event.account) {
    const owner = await membershipSubscriptionOwner(event.account, subscriptionId);
    if (owner.ok && owner.customerId && owner.productId) {
      const granted = await grantSubscriptionMembership(db, {
        customerId: owner.customerId,
        productId: owner.productId,
        subscriptionId,
        days,
        invoiceId: invoice.id,
      });
      if (granted.ok) {
        result = {
          ok: true,
          membershipId: granted.membershipId,
          endsAt: granted.endsAt,
          alreadyApplied: false,
          orgId: granted.orgId,
          siteId: granted.siteId,
        };
      } else {
        return { changed: false, detail: granted.reason };
      }
    }
  }

  if (!result.ok) {
    /**
     * Not an error. A merchant's Stripe account carries every subscription they
     * sell, including ones Markii knows nothing about — a plan they run outside
     * the platform, or a membership since deleted.
     */
    return { changed: false, detail: result.reason };
  }
  if (result.alreadyApplied) {
    return {
      changed: false,
      detail: `Invoice ${invoice.id} already extended membership ${result.membershipId}.`,
    };
  }

  /**
   * **The renewal meters** (§17, `docs/PRICING.md` §4.1).
   *
   * A renewal is real revenue on the merchant's account with no order behind it,
   * so it writes a `usage_record` with a null `orderId`. Leaving it out would
   * understate the merchant's threshold — and now that threshold fees are
   * actually invoiced, an understated threshold is an undercharge on a real
   * invoice rather than a wrong number on a dashboard.
   *
   * **A membership is `digital`** (`lib/commerce/product-class.ts`): it bills
   * against the digital threshold at the digital rate, which is a different
   * schedule from physical goods (D39).
   */
  const meteredMinor =
    invoice.total_excluding_tax ?? invoice.subtotal ?? invoice.amount_paid ?? 0;

  if (meteredMinor > 0) {
    await recordUsage(db, {
      orgId: result.orgId,
      siteId: result.siteId,
      /** No order exists — Stripe billed this on its own schedule. */
      orderId: null,
      type: "sale",
      /**
       * **Excludes tax**, per §4.1's net-sales definition: metering tax would
       * bill a merchant against money they merely collected for a government.
       * `total_excluding_tax` is Stripe's own figure for exactly that;
       * `subtotal` is the fallback on invoices that predate it.
       */
      amountMinor: meteredMinor,
      currency: (invoice.currency ?? "usd").toUpperCase(),
      productClass: "digital",
      /**
       * Stripe's own flag, not an inference. A merchant testing their store in
       * test mode must never move a real threshold (§4.1), and this is the only
       * trustworthy source for which mode the money moved in.
       */
      environment: event.livemode ? "production" : "test",
      /** One metering event per invoice, so a redelivery cannot double-count. */
      dedupeKey: `renewal:${invoice.id}`,
    });
  }

  return {
    detail:
      `Membership ${result.membershipId} extended ${days} day(s) to ` +
      `${result.endsAt?.toISOString() ?? "no expiry"}; metered ${meteredMinor} ` +
      `${(invoice.currency ?? "usd").toUpperCase()} as digital.`,
  };
}

/**
 * Resolves a Stripe subscription to a tenant.
 *
 * By subscription id first, falling back to the customer — a
 * `customer.subscription.created` arrives before the action has stored the
 * subscription id, so the customer is the only link that exists yet. Both are
 * unique columns, so neither lookup can resolve to more than one org.
 */
async function orgForSubscription(
  subscriptionId: string,
  customer?: string | { id?: string } | null,
): Promise<string | null> {
  const [bySub] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.stripeSubscriptionId, subscriptionId))
    .limit(1);
  if (bySub) return bySub.id;

  const customerId = typeof customer === "string" ? customer : (customer?.id ?? null);
  if (!customerId) return null;

  const [byCustomer] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.stripeCustomerId, customerId))
    .limit(1);
  return byCustomer?.id ?? null;
}

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
  "invoice.created",
  "invoice.finalized",
  "customer.subscription.trial_will_end",
  "payment_method.attached",
  "payment_method.detached",
  /** Handled today — listed so the expected/unexpected split stays complete. */
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
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
    /**
     * 400, and nothing is recorded: an unverified payload is not evidence of
     * anything, and writing it would let anyone fill this table.
     *
     * **The diagnosis goes to the log, never the response.** A rejected caller
     * learns only that it was rejected — telling it which secret is configured,
     * or what mode this deployment runs in, would be handing an attacker the
     * map. But the operator needs exactly that, and without it the most common
     * cause of this failure (a signing secret from the wrong *mode*, which no
     * startup check can detect because every secret looks like `whsec_…`)
     * presents as a bare "signature does not match" forever.
     */
    const key = process.env.STRIPE_SECRET_KEY ?? "";
    console.warn(
      `[stripe-webhook] rejected unverified event (${verified.reason}) — ` +
        diagnoseSignatureFailure({
          reason: verified.reason,
          claimedLivemode: typeof event.livemode === "boolean" ? event.livemode : undefined,
          isConnectEvent: Boolean(event.account),
          keyIsLive: !key.startsWith("sk_test") && !key.startsWith("rk_test"),
        }),
    );
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

  /**
   * **Mode agreement, checked on a verified event** — here `livemode` is
   * Stripe's own claim rather than the payload's, because the signature covered
   * it.
   *
   * A verified event whose mode disagrees with `STRIPE_SECRET_KEY` means a real
   * endpoint is pointed at the wrong deployment: live events arriving somewhere
   * holding test keys, or the reverse. Acting on it would resolve ids against
   * the other mode's data — every lookup missing, or worse, coincidentally
   * matching an unrelated row.
   *
   * Recorded as `ignored` **with a reason** rather than dropped, which is the
   * same treatment a recognised-but-unhandled type gets. `stripe_webhook_events`
   * exists to answer "what did Stripe send and what did we do about it", and
   * this is a case where the answer needs to be findable — unlike a signature
   * failure, nothing else about it looks wrong.
   */
  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const keyIsLive = !secretKey.startsWith("sk_test") && !secretKey.startsWith("rk_test");
  if (Boolean(event.livemode) !== keyIsLive) {
    const detail =
      `Mode mismatch: a ${event.livemode ? "live" : "test"}-mode event reached a deployment ` +
      `configured with a ${keyIsLive ? "live" : "test"}-mode STRIPE_SECRET_KEY. Nothing was ` +
      `acted on — ids from one mode do not resolve in the other. Point this endpoint at the ` +
      `matching deployment, or fix the key.`;
    await db
      .update(stripeWebhookEvents)
      .set({ status: "ignored", detail, processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, event.id));
    console.warn(`[stripe-webhook] ${detail}`);
    /**
     * 200, not an error. The event was verified and understood; this deployment
     * is simply not its audience. A 5xx would make Stripe retry for three days
     * against a mismatch that retrying cannot fix.
     */
    return NextResponse.json({ ok: true, handled: false, reason: detail });
  }

  const handler = HANDLERS[event.type];
  if (!handler) {
    const detail = EXPECTED_TYPES.has(event.type)
      ? "Recognised, but no handler is wired for it yet (§17)."
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
