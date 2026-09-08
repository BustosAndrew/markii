/**
 * Which Stripe events each rail must be subscribed to, and what breaks without
 * each one (§17, §18).
 *
 * **This exists because nothing notices when a subscription is edited away.**
 * `app/api/webhooks/stripe/route.ts` handles an event when it arrives; nothing
 * anywhere asks whether Stripe is still configured to send it. Unsubscribing
 * `invoice.created` in the dashboard is a two-click change that produces no
 * error, no log line and no failing test — the pre-charge stop for a halted
 * store simply stops firing, and only the weaker `invoice.paid` fallback runs.
 * `pnpm stripe:webhooks` reads this manifest and reports what is missing.
 *
 * **Kept deliberately narrow.** These are the events Markii *depends* on, not
 * every event it tolerates. A subscription carrying extra types is fine and is
 * not reported as a problem; one missing any of these is.
 *
 * The `reason` on each is what the report prints, so it has to say what stops
 * working rather than restate the event name.
 */

export type WebhookRail = "connect" | "platform";

export type RequiredEvent = {
  type: string;
  /** What silently stops working when Stripe is not sending this. */
  reason: string;
};

/**
 * Events on **merchants' connected accounts** — their money, their customers.
 *
 * Delivered only to an endpoint created with "Listen to events on Connected
 * accounts", and verified with `STRIPE_CONNECT_WEBHOOK_SECRET`. The route never
 * falls back between the two secrets, so a Connect event arriving at a
 * platform-only endpoint is refused rather than mis-attributed.
 */
export const REQUIRED_CONNECT_EVENTS: RequiredEvent[] = [
  {
    type: "account.updated",
    reason:
      "Card-rail eligibility goes stale. `chargesEnabled` is the gate on taking money, and " +
      "connected is not the same as able to charge.",
  },
  {
    type: "account.application.deauthorized",
    reason: "A merchant disconnecting Markii is never noticed; the rail keeps reporting connected.",
  },
  {
    type: "payment_intent.succeeded",
    reason:
      "The authoritative completion signal for a card order. A browser closed mid-redirect then " +
      "leaves a paid order unrecorded, with stock still reserved.",
  },
  {
    type: "payment_intent.payment_failed",
    reason: "Reservations from failed payments are never released, so stock stays held.",
  },
  {
    type: "payment_intent.canceled",
    reason: "Same as payment_failed — the reservation is never released.",
  },
  {
    type: "charge.refunded",
    reason:
      "A merchant refunding from their own Stripe dashboard is invisible: the order keeps " +
      "showing paid, the threshold meter keeps counting a reversed sale, stock never returns.",
  },
  {
    type: "charge.refund.updated",
    reason: "A refund that later fails or changes state is never reconciled.",
  },
  {
    type: "invoice.created",
    reason:
      "**The pre-charge stop for a halted store never fires** (D45). A lapsed merchant's members " +
      "keep being charged, and only the weaker invoice.paid refusal catches it — after the money " +
      "has moved.",
  },
  {
    type: "invoice.paid",
    reason:
      "Recurring memberships stop renewing. Stripe is the scheduler (§18.9); nothing here runs a " +
      "clock, so without this event `endsAt` is never extended and paid members lose access.",
  },
];

/**
 * Events on **Markii's own platform account** — merchants paying Markii.
 *
 * Verified with `STRIPE_WEBHOOK_SECRET`. `platformOnly` in the route refuses one
 * of these that arrives carrying an `account`, because a merchant's own
 * subscription must never move Markii's entitlements.
 */
export const REQUIRED_PLATFORM_EVENTS: RequiredEvent[] = [
  {
    type: "customer.subscription.created",
    reason: "A new subscription never grants its plan if the action's transaction rolled back.",
  },
  {
    type: "customer.subscription.updated",
    reason:
      "Entitlements stop tracking Stripe. A plan change, a cancellation, or a lapse into " +
      "past_due made from Stripe's own billing portal never reaches Markii.",
  },
  {
    type: "customer.subscription.deleted",
    reason: "A cancelled subscription keeps granting its plan forever.",
  },
  {
    type: "invoice.paid",
    reason: "A subscription that recovers from past_due is never re-mirrored as paid.",
  },
  {
    type: "invoice.payment_failed",
    reason:
      "A failed subscription payment leaves no record. Entitlements deliberately do not move " +
      "here — customer.subscription.updated reports the status — but the event is what makes " +
      "the failure visible at all.",
  },
];

export function requiredEventsFor(rail: WebhookRail): RequiredEvent[] {
  return rail === "connect" ? REQUIRED_CONNECT_EVENTS : REQUIRED_PLATFORM_EVENTS;
}

/**
 * Whether a subscription list covers a rail's requirements.
 *
 * `*` is Stripe's wildcard and satisfies everything — noisy, but not wrong, so
 * it is accepted rather than flagged.
 */
export function missingEvents(rail: WebhookRail, enabled: string[]): RequiredEvent[] {
  if (enabled.includes("*")) return [];
  const have = new Set(enabled);
  return requiredEventsFor(rail).filter((e) => !have.has(e.type));
}
