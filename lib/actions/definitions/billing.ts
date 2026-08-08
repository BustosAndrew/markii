import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { badRequest, notFound, ApiError } from "../../api";
import { feeAssessments, organizations, PLAN_IDS } from "../../db";
import { formatMinor } from "../../api/money";
import {
  assessmentBillable,
  createFeeInvoiceItem,
  feeLineDescription,
  type BillableAssessment,
} from "../../billing/fee-invoice";
import { statusGrantsPlan } from "../../billing/mirror";
import {
  billingConfigured,
  cancelAtPeriodEnd,
  changeSubscriptionPrice,
  createSetupIntent,
  createSubscription,
  ensureCustomer,
  matchedPublishableKey,
  previewPlanChange,
  resolvePrice,
  retrieveSubscription,
  setDefaultPaymentMethod,
  type StripeFailure,
} from "../../billing/stripe-billing";
import { mirrorSubscription } from "../../billing/mirror";
import { defineAction } from "../registry";

/**
 * Markii's own subscription billing (§17) — the half that charges *the
 * merchant*.
 *
 * These are actions rather than route-handler logic because §22 admits no
 * exceptions: a plan change is a mutation, so it is defined once and serves the
 * dashboard, the HTTP API, and any agent identically. It is also the mutation
 * where a privileged side path would be most expensive — moving
 * `organizations.plan_id` without a subscription behind it grants a higher GMV
 * threshold and more storefronts with nothing sold.
 *
 * **Stripe is called inside `run`, not through `ctx.effect`, and that is
 * deliberate.** Effects flush *after* the transaction commits, which is right
 * for an email but wrong here: what Stripe returns is an *input* to the database
 * write, not a consequence of it. The plan recorded is the one on the price
 * Stripe actually put on the subscription.
 *
 * The trade that buys is a window where Stripe has changed and the transaction
 * then rolls back, leaving the mirror behind. That window is why the
 * `customer.subscription.*` webhook handlers exist and why both paths write
 * through `lib/billing/mirror.ts` — Stripe redelivers, and the reconciliation
 * lands on the same derivation the action would have made.
 */

const planIdSchema = z.enum(PLAN_IDS);
const intervalSchema = z.enum(["month", "year"]);

/** Turns a Stripe refusal into the API's own error shape, reason intact. */
function refuse(failure: StripeFailure): never {
  const configuration = failure.code === "configuration_required";
  throw new ApiError(
    configuration ? "CONFIGURATION_REQUIRED" : "UPSTREAM_ERROR",
    /**
     * 503 for our own missing configuration, 502 for Stripe failing or refusing.
     * The split is what tells an operator whether to go set a variable or go
     * look at Stripe's status page.
     */
    configuration ? 503 : 502,
    failure.message,
    failure.resolution ? { resolution: failure.resolution } : undefined,
  );
}

async function loadOrg(db: Parameters<typeof mirrorSubscription>[0], orgId: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw notFound("Organization");
  return org;
}

/**
 * Change plan, or start the first subscription.
 *
 * **Two-step by contract** (§17: "Returns proration preview before commit").
 * Without `confirm`, this computes what the change would cost and writes
 * nothing; with `confirm`, it applies the change the merchant just saw. The
 * preview is Stripe's own arithmetic rather than a local recomputation — a
 * number that is usually right and occasionally differs is worse than no number,
 * because it is the one the merchant will hold us to.
 */
export const changePlan = defineAction({
  id: "billing.changePlan",
  description:
    "Move the organization onto a plan and billing interval, or start its first subscription. " +
    "Call without `confirm` to get the proration preview and the exact amount due; call again " +
    "with `confirm: true` to apply it. Nothing is charged and no entitlement moves until the " +
    "subscription is actually active.",
  input: z
    .object({
      planId: planIdSchema,
      interval: intervalSchema.default("month"),
      /** Without this the action previews only. The default is the safe one. */
      confirm: z.boolean().default(false),
    })
    .strict(),
  permission: "billing.write",
  /**
   * High: §22 rule 3 puts pricing behind human approval and forbids auto-run
   * whoever asks. An agent may propose an upgrade; a person confirms it.
   */
  riskTier: "high",
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    if (!billingConfigured()) {
      throw new ApiError(
        "CONFIGURATION_REQUIRED",
        503,
        "Stripe Billing is not connected on this deployment.",
        { resolution: "Set STRIPE_SECRET_KEY (docs/API.md §17)." },
      );
    }
    const orgId = ctx.actor.orgId;
    const org = await loadOrg(ctx.db, orgId);

    /**
     * Resolve the price first. It refuses when Stripe's amount disagrees with
     * the plan table, and doing that before anything else means a
     * misconfigured price costs a rejected request rather than a customer, a
     * subscription, and a charge the merchant was never shown.
     */
    const priced = await resolvePrice(input.planId, input.interval);
    if (!priced.ok) refuse(priced);
    const price = priced.price;

    const onSamePlan = org.planId === input.planId && org.subscriptionInterval === input.interval;
    if (onSamePlan && org.stripeSubscriptionId && !org.cancelAtPeriodEnd) {
      throw badRequest(`Already on ${input.planId}, billed ${input.interval}ly.`);
    }

    // --- First subscription -------------------------------------------------
    if (!org.stripeSubscriptionId) {
      if (!input.confirm || ctx.dryRun) {
        /**
         * No proration exists for a first subscription — there is no partial
         * period to credit — so the amount due is simply the price. This is
         * computed locally rather than previewed because previewing would need
         * a Stripe Customer, and creating one during a preview leaves an object
         * behind for a change the merchant may never confirm.
         */
        return {
          preview: {
            kind: "first_subscription" as const,
            amountDueMinor: price.unitAmountMinor,
            currency: price.currency,
            lines: [
              { description: `Markii ${input.planId} (${input.interval}ly)`, amountMinor: price.unitAmountMinor },
            ],
            nextChargeAt: null,
          },
          confirmed: false,
          charging: false,
          note: "Nothing has been charged. Call again with confirm: true to subscribe.",
        };
      }

      const customer = await ensureCustomer({
        orgId,
        existingCustomerId: org.stripeCustomerId,
        name: org.name,
        email: org.billingEmail,
      });
      if (!customer.ok) refuse(customer);

      /**
       * Persist the customer **before** creating the subscription. If the
       * subscription call then fails, the id is still recorded and the retry
       * reuses this customer — without this the id is lost with the exception,
       * and the next attempt creates a second customer once Stripe's 24-hour
       * idempotency window has passed. Two customers means the card the merchant
       * saved sits on the one that is not being billed.
       */
      if (customer.customerId !== org.stripeCustomerId) {
        await ctx.db
          .update(organizations)
          .set({ stripeCustomerId: customer.customerId, updatedAt: new Date() })
          .where(eq(organizations.id, orgId));
      }

      const created = await createSubscription({
        customerId: customer.customerId,
        priceId: price.id,
        orgId,
      });
      if (!created.ok) refuse(created);

      const mirrored = await mirrorSubscription(ctx.db, orgId, created.snapshot);
      if ("stale" in mirrored) throw badRequest(mirrored.reason);

      ctx.recordDiff({
        entity: "organization",
        entityId: orgId,
        path: "planId",
        before: org.planId,
        after: mirrored.planId,
      });

      return {
        confirmed: true,
        subscriptionId: created.snapshot.subscriptionId,
        status: mirrored.status,
        planId: mirrored.planId,
        /**
         * The subscription starts `incomplete` until the first invoice is paid,
         * so the plan has *not* moved yet and the response must not imply it
         * has. The client confirms this secret in Stripe Elements; the
         * `customer.subscription.updated` webhook is what finally grants the
         * plan.
         */
        clientSecret: created.clientSecret,
        /** Null when unset **or** in the other mode — see `matchedPublishableKey`. */
        publishableKey: matchedPublishableKey(),
        charging: true,
        note:
          mirrored.planId === input.planId
            ? "Subscription active."
            : "Subscription created but not yet paid — entitlements stay on the current plan " +
              "until the first invoice succeeds.",
      };
    }

    // --- Changing an existing subscription -----------------------------------
    if (!org.stripeCustomerId) {
      // A subscription with no customer id stored is a mirror that lost half of
      // itself. Refuse rather than create a second customer alongside the one
      // Stripe already has for this subscription.
      throw badRequest(
        "This organization has a subscription but no stored Stripe customer. Reconnect billing.",
      );
    }

    const current = await loadSubscriptionItem(org.stripeSubscriptionId);
    if (!current.ok) refuse(current);

    if (!input.confirm || ctx.dryRun) {
      const preview = await previewPlanChange({
        customerId: org.stripeCustomerId,
        subscriptionId: org.stripeSubscriptionId,
        itemId: current.itemId,
        priceId: price.id,
      });
      if (!preview.ok) refuse(preview);
      return {
        preview: { kind: "plan_change" as const, ...preview.preview },
        confirmed: false,
        charging: false,
        note: "Nothing has been charged. Call again with confirm: true to apply this change.",
      };
    }

    const changed = await changeSubscriptionPrice({
      subscriptionId: org.stripeSubscriptionId,
      itemId: current.itemId,
      priceId: price.id,
    });
    if (!changed.ok) refuse(changed);

    const mirrored = await mirrorSubscription(ctx.db, orgId, changed.snapshot);
    if ("stale" in mirrored) throw badRequest(mirrored.reason);

    ctx.recordDiff({
      entity: "organization",
      entityId: orgId,
      path: "planId",
      before: org.planId,
      after: mirrored.planId,
    });

    return {
      confirmed: true,
      subscriptionId: changed.snapshot.subscriptionId,
      status: mirrored.status,
      planId: mirrored.planId,
      charging: true,
      note: "Plan changed. Any proration appears on the next invoice.",
    };
  },
});

/**
 * Reads back the single subscription item, which is what a price change swaps.
 *
 * Stripe needs the item id to *replace* a line; without it the update appends a
 * second one and the merchant is billed for both plans.
 */
async function loadSubscriptionItem(
  subscriptionId: string,
): Promise<{ ok: true; itemId: string } | StripeFailure> {
  const res = await retrieveSubscription(subscriptionId);
  if (!res.ok) return res;
  if (!res.snapshot.itemId) {
    return {
      ok: false,
      code: "unavailable",
      message: "Subscription has no line item to change.",
    };
  }
  return { ok: true, itemId: res.snapshot.itemId };
}

/**
 * Cancel at period end, or withdraw a pending cancellation (§17 `DELETE`).
 *
 * Never cancels immediately. The merchant paid through the end of the period,
 * and taking their storefronts offline the moment they click would delete access
 * they already bought.
 */
export const setCancellation = defineAction({
  id: "billing.setCancellation",
  description:
    "Schedule the subscription to end when the current period does, or withdraw a scheduled " +
    "cancellation. Access and entitlements continue until the period actually ends — this never " +
    "cancels immediately.",
  input: z.object({ cancelAtPeriodEnd: z.boolean() }).strict(),
  permission: "billing.write",
  /** Reversible right up to the period boundary, which is what `undoable` means here. */
  riskTier: "medium",
  undoable: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;
    const org = await loadOrg(ctx.db, orgId);

    if (!org.stripeSubscriptionId) {
      throw badRequest("There is no active subscription to cancel.");
    }
    if (ctx.dryRun) {
      return {
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        endsAt: org.currentPeriodEnd?.toISOString() ?? null,
        applied: false,
      };
    }

    const res = await cancelAtPeriodEnd(org.stripeSubscriptionId, input.cancelAtPeriodEnd);
    if (!res.ok) refuse(res);

    const mirrored = await mirrorSubscription(ctx.db, orgId, res.snapshot);
    if ("stale" in mirrored) throw badRequest(mirrored.reason);

    ctx.recordDiff({
      entity: "organization",
      entityId: orgId,
      path: "cancelAtPeriodEnd",
      before: org.cancelAtPeriodEnd,
      after: res.snapshot.cancelAtPeriodEnd,
    });

    return {
      cancelAtPeriodEnd: res.snapshot.cancelAtPeriodEnd,
      /** Stated so no screen has to guess when access actually stops. */
      endsAt: res.snapshot.currentPeriodEnd?.toISOString() ?? null,
      status: mirrored.status,
      planId: mirrored.planId,
      applied: true,
    };
  },
});

/**
 * Opens a SetupIntent so the merchant can store a card (§17).
 *
 * Card data goes only to Stripe-hosted Elements and never touches Markii
 * (PCI SAQ-A). This creates the platform Customer if one does not exist yet,
 * which is why it is a mutation rather than a read.
 */
export const startPaymentMethodSetup = defineAction({
  id: "billing.startPaymentMethodSetup",
  description:
    "Return a Stripe SetupIntent client secret so a card can be collected in Stripe Elements. " +
    "Card details never reach Markii. Follow with billing.setDefaultPaymentMethod once Elements " +
    "confirms, or the stored card will not be the one invoices are charged to.",
  input: z.object({}).strict(),
  permission: "billing.write",
  riskTier: "low",
  async run(_input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    if (!billingConfigured()) {
      throw new ApiError(
        "CONFIGURATION_REQUIRED",
        503,
        "Card details cannot be collected — Stripe Billing is not connected.",
        { resolution: "Set STRIPE_SECRET_KEY (docs/API.md §17)." },
      );
    }
    const orgId = ctx.actor.orgId;
    const org = await loadOrg(ctx.db, orgId);

    if (ctx.dryRun) {
      // A dry run must not create a Stripe object; a rolled-back transaction
      // cannot un-create one.
      return { clientSecret: null, dryRun: true, customerExists: Boolean(org.stripeCustomerId) };
    }

    const customer = await ensureCustomer({
      orgId,
      existingCustomerId: org.stripeCustomerId,
      name: org.name,
      email: org.billingEmail,
    });
    if (!customer.ok) refuse(customer);

    if (customer.customerId !== org.stripeCustomerId) {
      await ctx.db
        .update(organizations)
        .set({ stripeCustomerId: customer.customerId, updatedAt: new Date() })
        .where(eq(organizations.id, orgId));
    }

    const intent = await createSetupIntent(customer.customerId);
    if (!intent.ok) refuse(intent);
    if (!intent.publishableKey) {
      throw new ApiError(
        "CONFIGURATION_REQUIRED",
        503,
        "Card details cannot be collected — Stripe Elements cannot load.",
        {
          resolution:
            "Set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, and make sure it is in the same mode as " +
            "STRIPE_SECRET_KEY. A pk_live_ key cannot confirm a secret issued by an sk_test_ key.",
        },
      );
    }

    return {
      clientSecret: intent.clientSecret,
      publishableKey: intent.publishableKey,
      customerId: customer.customerId,
    };
  },
});

/**
 * Bills closed threshold-fee assessments (§17, `docs/PRICING.md` §4).
 *
 * **This is the action that turns a measurement into a charge**, and it is the
 * only one. Everything else about the threshold fee — the ledger, the marginal
 * engine, the meter, period close — deliberately stopped short of money;
 * `fee_assessments.invoiced` was hardcoded `false` and every surface said so.
 *
 * It adds an invoice **item** per assessment, which rides onto the merchant's
 * next Markii subscription invoice as a named line showing its own arithmetic.
 * Nothing is finalised or captured here: Stripe bills it with the plan on the
 * normal cycle, so a merchant gets one invoice for one relationship.
 *
 * **Nothing is scheduled.** Like period close and the absent T12 rollup, this
 * runs when it is invoked — there is no job runner in this codebase, and a
 * billing step that silently depended on one would quietly never charge anyone.
 */
export const invoiceAssessments = defineAction({
  id: "billing.invoiceAssessments",
  description:
    "Bill closed threshold-fee assessments by adding them to the organization's next Markii " +
    "invoice. Each assessment bills exactly once. Call with dryRun to see what would be charged " +
    "and why, without raising anything.",
  input: z
    .object({
      /**
       * Explicit ids, or every unbilled assessment. Defaulting to "all closed
       * and unbilled" is safe only because each one refuses individually and
       * bills at most once.
       */
      assessmentIds: z.array(z.string().min(1).max(64)).max(100).optional(),
    })
    .strict(),
  permission: "billing.write",
  /** Charging a merchant real money. §22 rule 3: never auto-runs, whoever asks. */
  riskTier: "high",
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;
    const org = await loadOrg(ctx.db, orgId);

    const rows = await ctx.db
      .select()
      .from(feeAssessments)
      .where(and(eq(feeAssessments.orgId, orgId), eq(feeAssessments.invoiced, false)))
      .orderBy(asc(feeAssessments.periodStart));

    const wanted = input.assessmentIds
      ? rows.filter((r) => input.assessmentIds?.includes(r.id))
      : rows;

    /**
     * Read once, from the org's own mirror. A subscription that does not grant
     * a plan does not get billed a usage fee either — an `incomplete` signup has
     * no invoice for the item to ride on, which is the failure mode
     * `assessmentBillable` exists to refuse.
     */
    const context = {
      customerId: org.stripeCustomerId,
      subscriptionActive: statusGrantsPlan(org.subscriptionStatus ?? ""),
      billingCurrency: org.currency,
    };

    const billed: { id: string; feeMinor: number; invoiceItemId: string | null }[] = [];
    const skipped: { id: string; reason: string }[] = [];

    for (const row of wanted) {
      const assessment: BillableAssessment = {
        id: row.id,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        planId: row.planId,
        productClass: row.productClass,
        currency: row.currency,
        feeMinor: row.feeMinor,
        billableMinor: row.billableMinor,
        thresholdMinor: row.thresholdMinor,
        overageRateBps: row.overageRateBps,
        invoiced: row.invoiced,
      };

      const verdict = assessmentBillable(assessment, context);
      if (!verdict.ok) {
        /**
         * A zero fee is *settled*, not skipped: the merchant was under their
         * threshold and owes nothing, so the period closes rather than staying
         * pending forever and being re-examined every run.
         */
        if (row.feeMinor <= 0 && !ctx.dryRun) {
          await ctx.db
            .update(feeAssessments)
            .set({ invoiced: true, invoicedAt: new Date() })
            .where(eq(feeAssessments.id, row.id));
          billed.push({ id: row.id, feeMinor: 0, invoiceItemId: null });
          continue;
        }
        skipped.push({ id: row.id, reason: verdict.message });
        continue;
      }

      if (ctx.dryRun) {
        billed.push({ id: row.id, feeMinor: row.feeMinor, invoiceItemId: null });
        continue;
      }

      const item = await createFeeInvoiceItem({
        customerId: context.customerId as string,
        assessment,
        description: feeLineDescription(assessment, (m) => formatMinor(m, assessment.currency)),
      });
      if (!item.ok) {
        /**
         * Stop rather than continue. If Stripe is refusing or unreachable, the
         * next assessment will fail the same way, and a partial run that
         * reported "3 billed, 7 failed" invites a re-run that has to reason
         * about which is which. Each item is already durable and idempotent, so
         * stopping loses nothing.
         */
        skipped.push({ id: row.id, reason: item.message });
        break;
      }

      await ctx.db
        .update(feeAssessments)
        .set({ invoiced: true, invoicedAt: new Date(), stripeInvoiceItemId: item.invoiceItemId })
        .where(eq(feeAssessments.id, row.id));

      ctx.recordDiff({
        entity: "feeAssessment",
        entityId: row.id,
        path: "invoiced",
        before: false,
        after: true,
      });
      billed.push({ id: row.id, feeMinor: row.feeMinor, invoiceItemId: item.invoiceItemId });
    }

    const chargedMinor = billed.reduce((sum, b) => sum + b.feeMinor, 0);
    return {
      billed,
      skipped,
      chargedMinor,
      currency: org.currency,
      /**
       * True only when something was actually raised. A run that settled nothing
       * but zero-fee periods moved no money, and saying otherwise would be the
       * §4.4 framing problem in reverse.
       */
      charging: !ctx.dryRun && billed.some((b) => b.invoiceItemId !== null),
      dryRun: ctx.dryRun,
      note: ctx.dryRun
        ? "Nothing was raised. These are the assessments that would be billed."
        : "Raised as invoice items — they appear on the next Markii subscription invoice, " +
          "not as a separate charge.",
    };
  },
});

/**
 * Promotes a card collected via Elements to the customer's default.
 *
 * Attaching a payment method does not make it the one invoices are charged to.
 * Without this step a merchant adds a card, sees it saved, and the next renewal
 * still fails against nothing.
 */
export const setDefaultCard = defineAction({
  id: "billing.setDefaultPaymentMethod",
  description:
    "Make a payment method the default for this organization's Markii invoices. Called with the " +
    "id Stripe Elements returns after a SetupIntent is confirmed.",
  input: z.object({ paymentMethodId: z.string().min(1).max(255) }).strict(),
  permission: "billing.write",
  riskTier: "medium",
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const org = await loadOrg(ctx.db, ctx.actor.orgId);
    if (!org.stripeCustomerId) {
      throw badRequest("No Stripe customer exists for this organization yet.");
    }
    if (ctx.dryRun) return { applied: false, dryRun: true };

    const res = await setDefaultPaymentMethod(org.stripeCustomerId, input.paymentMethodId);
    if (!res.ok) refuse(res);
    return { applied: true };
  },
});
