import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api";
import { invokeAction } from "@/lib/actions";
import { orgHandler } from "@/lib/auth/handler";
import { currentPeriod } from "@/lib/billing/meter";
import { billingConfigured, defaultCard } from "@/lib/billing/stripe-billing";
import { statusGrantsPlan } from "@/lib/billing/mirror";
import { db, organizations } from "@/lib/db";
import { entitlementsFor, planPricing } from "@/lib/plans";

/**
 * `/api/billing/subscription` (§17).
 *
 * **`GET` reads the mirror, not Stripe.** `organizations.subscription_*` is kept
 * current by the `billing.changePlan` action and the `customer.subscription.*`
 * webhooks (`lib/billing/mirror.ts`). Calling Stripe on every page load would
 * put a third party's latency and uptime in front of the billing screen for a
 * value that is written the moment it changes. The card is the one exception —
 * it is fetched live, because a card that expired or was removed in Stripe's own
 * portal has no event that reliably reaches here, and a stale "•••• 4242" is
 * exactly the thing a merchant would rely on.
 *
 * **`POST` and `DELETE` do not mutate here.** They delegate to the action
 * registry (§22 rule 1) — same validation, same permission check, same audit
 * record whether the caller is this route, `POST /api/actions/:id`, or an agent.
 */
export const GET = orgHandler(
  async (_req, { orgId }) => {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw notFound("Organization");

    const entitlements = entitlementsFor(org);
    const pricing = planPricing(org.planId);
    const period = currentPeriod();

    /**
     * Fetched live and allowed to fail softly: a Stripe outage should not blank
     * the whole billing screen. `null` here means "no card on file"; the
     * distinction from "could not ask" is carried by `paymentMethodState`.
     */
    let paymentMethod: Awaited<ReturnType<typeof defaultCard>> | null = null;
    if (org.stripeCustomerId && billingConfigured()) {
      paymentMethod = await defaultCard(org.stripeCustomerId);
    }

    const subscribed = Boolean(org.stripeSubscriptionId && org.subscriptionStatus);

    return NextResponse.json({
      planId: org.planId,
      /**
       * Entitlements are what screens gate on, never the plan name (§17,
       * `docs/PRICING.md` §5). Plans change; capabilities are stable.
       */
      entitlements,
      pricing: {
        monthlyPriceMinor: pricing.monthlyPriceMinor,
        annualPerMonthMinor: pricing.annualPerMonthMinor,
        currency: "USD",
        status: "proposed" as const,
      },
      /**
       * The metering period the threshold fee is computed over. It is **not** the
       * Stripe billing period below, and is labeled so nobody reads it as one.
       */
      meteringPeriod: {
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        basis: "calendar_month",
      },
      subscription: subscribed
        ? {
            planId: org.planId,
            interval: org.subscriptionInterval,
            status: org.subscriptionStatus,
            currentPeriodStart: org.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
            trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
            cancelAtPeriodEnd: org.cancelAtPeriodEnd,
            paymentMethod: paymentMethod?.ok ? paymentMethod.card : null,
            /**
             * Stated rather than inferred from `status` by each caller. A
             * subscription can exist and grant nothing — `incomplete` is a
             * signup whose first invoice was never paid — and a screen that
             * equated "has a subscription" with "is on the plan" would show a
             * merchant a tier they are not being charged for.
             */
            entitlesPlan: statusGrantsPlan(org.subscriptionStatus ?? ""),
          }
        : null,
      paymentMethodState:
        paymentMethod && !paymentMethod.ok
          ? { code: "unavailable" as const, message: paymentMethod.message }
          : null,
      subscriptionState: subscriptionState(org.subscriptionStatus, subscribed),
    });
  },
  { permission: "billing.read" },
);

/**
 * Why the merchant is, or is not, being charged — in the response, every time.
 *
 * `charging` here is about **the subscription**, and it is deliberately narrower
 * than it looks: threshold fees are still not invoiced (`fee_assessments.invoiced`
 * is false and `GET /api/billing/usage` says so separately). Letting one flag
 * stand for both would be the same false claim the meter's own docstring warns
 * about — a credential is not a capability.
 */
function subscriptionState(status: string | null, subscribed: boolean) {
  if (!billingConfigured()) {
    return {
      code: "configuration_required" as const,
      message: "Stripe Billing is not connected — no subscription can exist.",
      resolution:
        "This deployment needs additional platform configuration. Contact your Markii admin.",
      charging: false,
    };
  }
  if (!subscribed) {
    return {
      code: "not_subscribed" as const,
      message: "No subscription — entitlements come from the plan floor and nothing is charged.",
      resolution: "Start one with billing.changePlan.",
      charging: false,
    };
  }
  if (status && statusGrantsPlan(status)) {
    return {
      code: "active" as const,
      message:
        status === "past_due"
          ? "A renewal payment failed and Stripe is retrying. Access continues while it does."
          : "Subscription is current.",
      /** Threshold fees are a separate meter and separately not billed yet. */
      charging: true,
      thresholdFeesCharging: false,
    };
  }
  return {
    code: "inactive" as const,
    message: `Subscription is ${status} — it grants no plan, so entitlements sit at the floor.`,
    resolution:
      status === "incomplete"
        ? "The first invoice has not been paid. Confirm the payment in Stripe Elements."
        : "Start a new subscription with billing.changePlan.",
    charging: false,
  };
}

/**
 * Create or change a plan. Returns a **proration preview** unless `confirm` is
 * set, which is the §17 contract ("Returns proration preview before commit").
 *
 * The work happens in `billing.changePlan`; this is a documented alias for it,
 * not a second implementation.
 */
export const POST = orgHandler(
  async (req, { session }) => {
    const raw = await req.text();
    const input = raw ? JSON.parse(raw) : {};
    const outcome = await invokeAction("billing.changePlan", input, { actor: session.actor });
    return NextResponse.json(outcome);
  },
  { permission: "billing.write" },
);

/**
 * Cancel at period end (§17). Never immediate — the merchant paid through the
 * end of the period, and revoking now would delete access they already bought.
 */
export const DELETE = orgHandler(
  async (_req, { session }) => {
    const outcome = await invokeAction(
      "billing.setCancellation",
      { cancelAtPeriodEnd: true },
      { actor: session.actor },
    );
    return NextResponse.json(outcome);
  },
  { permission: "billing.write" },
);
