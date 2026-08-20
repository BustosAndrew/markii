import { and, asc, eq, inArray } from "drizzle-orm";
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
import { closePeriod } from "../../billing/close";
import { periodStartingAt, previousPeriod } from "../../billing/meter";
import {
  billingConfigured,
  cancelAtPeriodEnd,
  cancelSubscriptionNow,
  changeSubscriptionPrice,
  classifySubscription,
  createSetupIntent,
  createSubscription,
  ensureCustomer,
  matchedPublishableKey,
  previewPlanChange,
  resolvePrice,
  retrievePayableSubscription,
  setDefaultPaymentMethod,
  type StripeFailure,
  type SubscriptionSnapshot,
} from "../../billing/stripe-billing";
import { mirrorCancellation, mirrorSubscription } from "../../billing/mirror";
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
  /** D40 step-up: moves money or grants access. */
  requiresStepUp: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    if (!billingConfigured()) {
      throw new ApiError(
        "CONFIGURATION_REQUIRED",
        503,
        "Stripe Billing is not connected on this deployment.",
        {
          resolution:
            "This deployment needs additional platform configuration. Contact your Markii admin.",
        },
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

    /**
     * **A stored subscription id is not the same as a usable subscription**, and
     * gating the first-subscription path on the id alone is what stranded orgs
     * holding one Stripe had already expired: every later attempt fell into the
     * change-an-existing-subscription branch and failed against a dead object,
     * while cancelling refused because the subscription granted nothing. Find
     * out what the id actually points at before choosing a path.
     */
    const existing = await resolveExistingSubscription(
      ctx.db,
      orgId,
      org.stripeSubscriptionId,
      { persist: !ctx.dryRun },
    );

    /**
     * Only a **live** subscription can already be on the plan. An unpaid one
     * leaves `organizations.plan_id` at the floor, so this guard used to refuse
     * the merchant's attempt to pay for the very plan they had just chosen.
     */
    if (
      existing.kind === "live" &&
      org.planId === input.planId &&
      org.subscriptionInterval === input.interval &&
      !org.cancelAtPeriodEnd
    ) {
      throw badRequest(`Already on ${input.planId}, billed ${input.interval}ly.`);
    }

    /** Set when a dead-on-arrival subscription is discarded to make room for this one. */
    let replacing: string | null = null;

    // --- An unpaid subscription: reopen its invoice, or replace it ------------
    if (existing.kind === "unpaid") {
      const samePrice =
        existing.snapshot.planId === input.planId &&
        existing.snapshot.interval === input.interval;

      if (!input.confirm || ctx.dryRun) {
        return {
          preview: startPreview(input.planId, input.interval, price),
          confirmed: false,
          charging: false,
          note: samePrice
            ? "This subscription was created but never paid. Confirming reopens its existing " +
              "invoice — it does not create a second subscription or a second charge."
            : "This subscription was created but never paid. Confirming discards it and starts " +
              "one on the plan you picked.",
        };
      }

      if (samePrice && existing.clientSecret) {
        /**
         * Reopen rather than recreate. The open invoice is already finalized at
         * this price, so a second subscription would be two invoices for one
         * decision — and Stripe would go on trying to collect both.
         */
        const mirrored = await mirrorSubscription(ctx.db, orgId, existing.snapshot);
        if ("stale" in mirrored) throw badRequest(mirrored.reason);
        return {
          confirmed: true,
          subscriptionId: existing.snapshot.subscriptionId,
          status: mirrored.status,
          planId: mirrored.planId,
          clientSecret: existing.clientSecret,
          publishableKey: matchedPublishableKey(),
          charging: true,
          /** Distinguishes "paying the one you already have" from "a new one". */
          resumed: true,
          note:
            "Reopened the unpaid invoice on the existing subscription. It grants nothing until " +
            "the payment succeeds.",
        };
      }

      /**
       * A different plan, or an invoice Stripe will no longer hand a secret back
       * for. A finalized invoice cannot be re-priced, so the honest move is to
       * end this subscription and start the chosen one — in that order, so a
       * failure leaves one dead subscription rather than two live ones.
       */
      const discarded = await cancelSubscriptionNow(existing.snapshot.subscriptionId);
      if (!discarded.ok) refuse(discarded);
      const cleared = await mirrorCancellation(ctx.db, orgId, existing.snapshot.subscriptionId);
      if ("stale" in cleared) throw badRequest(cleared.reason);
      replacing = existing.snapshot.subscriptionId;
    }

    // --- First subscription ---------------------------------------------------
    if (existing.kind !== "live") {
      if (!input.confirm || ctx.dryRun) {
        /**
         * No proration exists for a first subscription — there is no partial
         * period to credit — so the amount due is simply the price. This is
         * computed locally rather than previewed because previewing would need
         * a Stripe Customer, and creating one during a preview leaves an object
         * behind for a change the merchant may never confirm.
         */
        return {
          preview: startPreview(input.planId, input.interval, price),
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
        replacing,
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
        /** The dead subscription this one replaced, when there was one. */
        replaced: replacing,
        note:
          mirrored.planId === input.planId
            ? "Subscription active."
            : "Subscription created but not yet paid — entitlements stay on the current plan " +
              "until the first invoice succeeds.",
      };
    }

    // --- Changing a live subscription -----------------------------------------
    if (!org.stripeCustomerId) {
      // A subscription with no customer id stored is a mirror that lost half of
      // itself. Refuse rather than create a second customer alongside the one
      // Stripe already has for this subscription.
      throw badRequest(
        "This organization has a subscription but no stored Stripe customer. Reconnect billing.",
      );
    }

    /**
     * Stripe needs the item id to *replace* a line; without it the update
     * appends a second one and the merchant is billed for both plans. It comes
     * from the snapshot already read above rather than from a second retrieve.
     */
    const itemId = existing.snapshot.itemId;
    if (!itemId) throw badRequest("Subscription has no line item to change.");

    if (!input.confirm || ctx.dryRun) {
      const preview = await previewPlanChange({
        customerId: org.stripeCustomerId,
        subscriptionId: existing.snapshot.subscriptionId,
        itemId,
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
      subscriptionId: existing.snapshot.subscriptionId,
      itemId,
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
 * The amount due to *start* a subscription.
 *
 * Not a proration — there is no partial period to credit — so it is simply the
 * price. Shared by the fresh-start and the reopen-an-unpaid-one paths, so the
 * two cannot quote a merchant different numbers for the same decision.
 */
function startPreview(
  planId: string,
  interval: string,
  price: { unitAmountMinor: number; currency: string },
) {
  return {
    kind: "first_subscription" as const,
    amountDueMinor: price.unitAmountMinor,
    currency: price.currency,
    lines: [
      { description: `Markii ${planId} (${interval}ly)`, amountMinor: price.unitAmountMinor },
    ],
    nextChargeAt: null,
  };
}

/** What the org's stored subscription id turned out to point at. */
type ExistingSubscription =
  | { kind: "none" }
  | { kind: "unpaid"; snapshot: SubscriptionSnapshot; clientSecret: string | null }
  | { kind: "live"; snapshot: SubscriptionSnapshot };

/**
 * Resolves the stored subscription id against Stripe, correcting the mirror when
 * it points at nothing.
 *
 * **A 404 and a Stripe outage are treated as opposites**, which is exactly what
 * the `status` field on `StripeFailure` exists for: "gone" is safe to replace,
 * "did not answer" never is — recreating on an outage would leave the merchant
 * with two subscriptions and two invoices.
 *
 * `persist` is false on a dry run, where the classification is still needed but
 * no write may happen. The correction is otherwise applied even on a preview:
 * it drops a pointer to an object that no longer exists, which is a repair
 * rather than a change to anything the merchant decided.
 */
async function resolveExistingSubscription(
  db: Parameters<typeof mirrorSubscription>[0],
  orgId: string,
  subscriptionId: string | null,
  opts: { persist: boolean },
): Promise<ExistingSubscription> {
  if (!subscriptionId) return { kind: "none" };

  const res = await retrievePayableSubscription(subscriptionId);
  if (!res.ok) {
    /**
     * Stripe does not have it — created against other credentials, or deleted
     * in the dashboard. Nothing can be paid or cancelled through it again, so
     * the id is dropped and the merchant gets a working "Subscribe" back
     * instead of a permanent error.
     */
    if (res.status === 404) {
      if (opts.persist) await mirrorCancellation(db, orgId, subscriptionId);
      return { kind: "none" };
    }
    refuse(res);
  }

  const kind = classifySubscription(res.snapshot.status);
  if (kind === "dead") {
    if (opts.persist) await mirrorCancellation(db, orgId, subscriptionId);
    return { kind: "none" };
  }
  if (kind === "unpaid") {
    return { kind: "unpaid", snapshot: res.snapshot, clientSecret: res.clientSecret };
  }
  return { kind: "live", snapshot: res.snapshot };
}

/**
 * Cancel at period end, or withdraw a pending cancellation (§17 `DELETE`).
 *
 * Never cancels immediately **when there is paid access to protect**. The
 * merchant paid through the end of the period, and taking their storefronts
 * offline the moment they click would delete access they already bought.
 *
 * The exception is a subscription that granted nothing: an `incomplete` one
 * whose first invoice was never paid, or one Stripe no longer has. There is no
 * paid period to run out, and scheduling a cancellation against a boundary that
 * may not exist is how an org ends up pointing at a row it can neither pay nor
 * clear — **the state where the plan picker offered no cancel button at all**,
 * because `entitlesPlan` was false. Those are discarded outright.
 */
export const setCancellation = defineAction({
  id: "billing.setCancellation",
  description:
    "Schedule the subscription to end when the current period does, or withdraw a scheduled " +
    "cancellation. Access and entitlements continue until the period actually ends — this never " +
    "cancels paid access immediately. An unpaid subscription grants nothing and is discarded " +
    "outright instead, which is what frees the organization to subscribe again.",
  input: z.object({ cancelAtPeriodEnd: z.boolean() }).strict(),
  permission: "billing.write",
  /** Reversible right up to the period boundary, which is what `undoable` means here. */
  riskTier: "medium",
  undoable: true,
  /**
   * The same action with the flag it had before. Withdrawing a cancellation is
   * this action too, so undo needs no separate capability.
   *
   * **The discard path is deliberately not undoable.** It records a
   * `stripeSubscriptionId` diff rather than a `cancelAtPeriodEnd` one, so this
   * returns null and undo refuses — which is correct: the subscription is gone
   * at Stripe, and "restoring" it would mean creating a different one.
   */
  inverse: (recorded) => {
    const entry = recorded.diff.find((d) => d.path === "cancelAtPeriodEnd");
    if (!entry || typeof entry.before !== "boolean") return null;
    return {
      actionId: "billing.setCancellation",
      input: { cancelAtPeriodEnd: entry.before },
      /**
       * Stripe holds the truth, and this action's dry run answers without
       * calling it — so a strict check would compare against nothing. Stripe
       * itself refuses the change if the subscription has since ended.
       */
      conflictCheck: "none" as const,
    };
  },
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

    const existing = await resolveExistingSubscription(
      ctx.db,
      orgId,
      org.stripeSubscriptionId,
      { persist: true },
    );

    /**
     * Stripe has nothing under that id, or only a terminal husk of one.
     * `resolveExistingSubscription` has already cleared the mirror; all that is
     * left is to say so, so the merchant sees "not subscribed" rather than an
     * error against an object nobody can act on.
     */
    if (existing.kind === "none") {
      ctx.recordDiff({
        entity: "organization",
        entityId: orgId,
        path: "stripeSubscriptionId",
        before: org.stripeSubscriptionId,
        after: null,
      });
      return {
        cancelAtPeriodEnd: false,
        endsAt: null,
        discarded: true,
        applied: true,
        note:
          "That subscription no longer exists at Stripe. The organization has been cleared and " +
          "can subscribe again.",
      };
    }

    /**
     * An unpaid subscription is discarded, not scheduled. Nothing was ever
     * charged for it and it grants nothing, so there is no period to preserve —
     * and leaving it in place is what blocked both subscribing and cancelling.
     */
    if (existing.kind === "unpaid") {
      if (!input.cancelAtPeriodEnd) {
        throw badRequest(
          "This subscription was never paid, so there is no scheduled cancellation to withdraw.",
        );
      }
      const ended = await cancelSubscriptionNow(existing.snapshot.subscriptionId);
      if (!ended.ok) refuse(ended);
      const cleared = await mirrorCancellation(ctx.db, orgId, existing.snapshot.subscriptionId);
      if ("stale" in cleared) throw badRequest(cleared.reason);

      ctx.recordDiff({
        entity: "organization",
        entityId: orgId,
        path: "stripeSubscriptionId",
        before: existing.snapshot.subscriptionId,
        after: null,
      });

      return {
        cancelAtPeriodEnd: false,
        endsAt: null,
        discarded: true,
        status: "canceled" as const,
        planId: cleared.planId,
        applied: true,
        note: "Discarded the unpaid subscription. Nothing was charged for it.",
      };
    }

    const res = await cancelAtPeriodEnd(existing.snapshot.subscriptionId, input.cancelAtPeriodEnd);
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
        {
          resolution:
            "This deployment needs additional platform configuration. Contact your Markii admin.",
        },
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
            "Card collection needs additional platform configuration. Contact your Markii admin.",
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
 * Freezes a finished period into `fee_assessments` (`docs/PRICING.md` §4.5).
 *
 * **Period close had no caller at all before this** — `closePeriod()` was
 * written, tested, and reachable from nothing, which meant the live meter was
 * the only number a merchant ever saw and no period was ever settled. An engine
 * with no entry point is indistinguishable from an engine that does not work.
 *
 * It is an action rather than a bare function call from the scheduler because
 * §22 rule 1 admits no exceptions: closing writes the row that decides what a
 * merchant is billed, so it gets the same validation, the same permission check,
 * and — the reason that matters here — the same audit record whether a human, an
 * agent, or the cron ran it. When a merchant disputes a fee, "who closed this
 * period, when, and what did it write" has an answer.
 *
 * **No step-up.** Closing raises no charge; it records what already happened.
 * The step-up boundary sits on `billing.invoiceAssessments`, which is where the
 * measurement becomes money (D40).
 */
export const closeBillingPeriod = defineAction({
  id: "billing.closePeriod",
  description:
    "Freeze a finished billing period into a threshold-fee assessment. Measures only — it bills " +
    "nothing; billing.invoiceAssessments does that. Idempotent: re-closing a period returns the " +
    "existing assessment rather than assessing twice. Defaults to the period that just ended.",
  permission: "billing.write",
  /**
   * Not `high`. It moves no money and cannot overwrite a settled number — the
   * unique key on `(orgId, periodStart)` makes a second close a read. The
   * irreversibility that would argue for `high` is the same property that makes
   * it safe to re-run.
   */
  riskTier: "medium",
  input: z
    .object({
      /**
       * The period's first instant, ISO-8601. Optional: the scheduler passes it
       * explicitly so every org in one sweep closes the *same* window even if
       * the run straddles midnight, and a human omits it to close the month
       * that just ended.
       */
      periodStart: z.string().datetime().optional(),
    })
    .strict(),
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");

    const period = input.periodStart
      ? periodStartingAt(new Date(input.periodStart))
      : previousPeriod();

    /**
     * **The one refusal that protects the number.** Closing a period that can
     * still receive sales freezes a partial month, and because close is
     * idempotent the remainder is then never assessed — the merchant is
     * undercharged and every surface still reads as settled. A caller passing a
     * future or current period is asking for that, so it is refused rather than
     * clamped: silently closing a different period than the one requested is its
     * own billing surprise.
     */
    if (period.end.getTime() > Date.now()) {
      throw badRequest(
        `Period ${period.start.toISOString().slice(0, 10)} has not ended yet (it runs to ` +
          `${period.end.toISOString().slice(0, 10)}). A period is closed after it ends, never during.`,
      );
    }

    const result = await closePeriod({
      orgId: ctx.actor.orgId,
      periodStart: period.start,
      periodEnd: period.end,
      handle: ctx.db,
    });

    if (!result.alreadyClosed && result.assessmentId) {
      ctx.recordDiff({
        entity: "feeAssessment",
        entityId: result.assessmentId,
        path: "closed",
        before: null,
        after: result.feeMinor,
      });
    }

    return {
      ...result,
      /**
       * Stated rather than left to be inferred from `invoiced: false`. Close and
       * bill are separate steps on purpose, and a caller who reads a fee here
       * has not yet charged anybody.
       */
      note: result.alreadyClosed
        ? "Already closed; the existing assessment was returned unchanged."
        : "Measured and frozen. Nothing is billed until billing.invoiceAssessments runs.",
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
 * **This is scheduled now** (§25). `GET /api/cron/billing` runs it monthly after
 * `billing.closePeriod`, so crossing a threshold results in a charge without
 * anyone remembering to press anything. It stays fully invocable by hand — the
 * sweep is a caller, not a second implementation.
 *
 * The scheduler reaches it as a `system` actor, which waives the step-up below.
 * That waiver rests entirely on `CRON_SECRET` (`lib/cron/auth.ts`, D41); nothing
 * else may mint a system actor from a request.
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
  /** D40 step-up: moves money or grants access. */
  requiresStepUp: true,
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
     * **Requested ids that this run will not touch, accounted for by name.**
     *
     * `rows` is filtered to `invoiced = false`, so an id that is already billed
     * — or belongs to another org, or does not exist — simply vanished from
     * `wanted` and the caller got back empty `billed` *and* empty `skipped`.
     * That is the silent no-op `lib/billing/fee-invoice.ts` is explicitly
     * written against: "a silent no-op is indistinguishable from a success",
     * and a caller naming an id deserves to know which of those happened.
     *
     * Only for an explicit list. The default run means "everything outstanding",
     * where an already-billed period is not an unanswered request.
     */
    const unaccounted: { id: string; reason: string }[] = [];
    if (input.assessmentIds?.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = input.assessmentIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        /**
         * Scoped to this org, so an id belonging to another merchant reads as
         * "no such assessment" rather than confirming it exists elsewhere —
         * the same reason `/api/billing/invoices/:id` answers 404 over 403.
         */
        const known = await ctx.db
          .select({ id: feeAssessments.id, invoicedAt: feeAssessments.invoicedAt })
          .from(feeAssessments)
          .where(and(eq(feeAssessments.orgId, orgId), inArray(feeAssessments.id, missing)));
        const byId = new Map(known.map((k) => [k.id, k]));

        for (const id of missing) {
          const row = byId.get(id);
          unaccounted.push({
            id,
            reason: row
              ? `Already invoiced${row.invoicedAt ? ` on ${row.invoicedAt.toISOString().slice(0, 10)}` : ""}. A closed period bills once.`
              : "No such assessment for this organization.",
          });
        }
      }
    }

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
    /** Seeded with requested ids this run cannot act on, so none goes unanswered. */
    const skipped: { id: string; reason: string }[] = [...unaccounted];

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
  /** D40 step-up: moves money or grants access. */
  requiresStepUp: true,
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
