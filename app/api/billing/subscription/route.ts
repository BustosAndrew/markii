import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { currentPeriod } from "@/lib/billing/meter";
import { db, organizations } from "@/lib/db";
import { entitlementsFor, planPricing } from "@/lib/plans";

/**
 * `/api/billing/subscription` (§17).
 *
 * **`GET` is real; changing a plan is not, and says so.** Stripe Billing is not
 * connected — no `STRIPE_SECRET_KEY` exists — so there is no subscription
 * object to read, no proration to preview, and no card to charge. What does
 * exist, and is what every gate in the product actually reads, is the org's
 * plan and its derived entitlements.
 *
 * Returning an invented `active` subscription with fabricated period dates
 * would be the most consequential kind of fiction in this codebase: a merchant
 * would believe they were paying for something and covered by it.
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
       * The metering period the threshold fee is computed over. It is **not** a
       * Stripe billing period, and is labeled so nobody reads it as one.
       */
      meteringPeriod: {
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        basis: "calendar_month",
      },
      subscription: null,
      subscriptionState: {
        code: "configuration_required" as const,
        message: "No billing subscription exists — Stripe Billing is not connected.",
        resolution:
          "Set STRIPE_SECRET_KEY and configure Stripe Billing. Until then plans and entitlements " +
          "work, threshold fees accrue and display, and nothing is charged.",
        /** Stated because the meter shows numbers that look like a bill. */
        charging: false,
      },
    });
  },
  { permission: "billing.read" },
);

/**
 * Plan changes and cancellation need Stripe.
 *
 * These refuse rather than mutating `organizations.planId` directly. Silently
 * moving a merchant to Scale without a subscription behind it would hand them
 * a higher threshold and more storefronts for free, and Markii would have no
 * record of anything having been sold.
 */
const stripeRequired = () =>
  NextResponse.json(
    {
      error: {
        code: "CONFIGURATION_REQUIRED",
        message: "Plan changes need a billing connection, which this deployment does not have.",
        details: {
          resolution:
            "Set STRIPE_SECRET_KEY and configure Stripe Billing (docs/API.md §17). Entitlements " +
            "are driven by the org's plan, so changing it without a subscription would grant " +
            "paid capability with nothing sold.",
        },
      },
    },
    { status: 503 },
  );

export const POST = orgHandler(async () => stripeRequired(), { permission: "billing.write" });
export const DELETE = orgHandler(async () => stripeRequired(), { permission: "billing.write" });
