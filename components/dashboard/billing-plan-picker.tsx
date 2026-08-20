"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  cancelSubscription,
  updateSubscription,
  type BillingInterval,
  type PlanCatalogItem,
  type PlanId,
  type PlanChangePreview,
  type SubscriptionResponse,
} from "@/lib/api/billing";
import { formatMinor } from "@/lib/api/money";
import { publicErrorMessage, sanitizePublicCopy } from "@/lib/api/public-copy";
import { SubscriptionPayForm } from "@/components/dashboard/subscription-pay-form";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const PLAN_ORDER: PlanId[] = ["starter", "growth", "scale"];

function grantsPlan(status: string | undefined) {
  return status === "active" || status === "trialing" || status === "past_due";
}

export function BillingPlanPicker({
  plans,
  currency,
  pricingNote,
  subscription,
}: {
  plans: PlanCatalogItem[];
  currency: string;
  pricingNote: string;
  subscription: SubscriptionResponse;
}) {
  const router = useRouter();
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [busyPlan, setBusyPlan] = useState<PlanId | null>(null);
  const [preview, setPreview] = useState<{
    planId: PlanId;
    preview: PlanChangePreview;
  } | null>(null);
  const [pay, setPay] = useState<{
    planId: PlanId;
    clientSecret: string;
    publishableKey: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  const current =
    subscription.subscription?.entitlesPlan === true
      ? subscription.subscription.planId
      : null;
  const unpaid =
    subscription.subscription != null &&
    subscription.subscription.entitlesPlan !== true;
  const unpaidPlanId = unpaid ? subscription.subscription?.planId ?? null : null;

  async function requestPreview(planId: PlanId) {
    setBusyPlan(planId);
    setError(null);
    setMessage(null);
    setPay(null);
    try {
      const outcome = await updateSubscription({ planId, interval });
      if (!outcome.ok || !outcome.result?.preview) {
        setError(
          sanitizePublicCopy(outcome.result?.note ?? "") ||
            "Could not load a proration preview.",
        );
        return;
      }
      setPreview({ planId, preview: outcome.result.preview });
    } catch (err) {
      setError(publicErrorMessage(err, "Plan change failed."));
    } finally {
      setBusyPlan(null);
    }
  }

  async function confirmChange() {
    if (!preview) return;
    const planId = preview.planId;
    setBusyPlan(planId);
    setError(null);
    try {
      const outcome = await updateSubscription({
        planId,
        interval,
        confirm: true,
      });
      if (!outcome.ok || !outcome.result) {
        setError(
          sanitizePublicCopy(outcome.result?.note ?? "") ||
            "Could not apply the plan change.",
        );
        return;
      }
      const secret = outcome.result.clientSecret;
      const publishableKey = outcome.result.publishableKey;
      if (secret && publishableKey?.startsWith("pk_")) {
        setPay({ planId, clientSecret: secret, publishableKey });
        setPreview(null);
        setMessage(null);
        return;
      }
      if (grantsPlan(outcome.result.status)) {
        setMessage(
          sanitizePublicCopy(outcome.result.note ?? "") || "Plan change applied.",
        );
        setPreview(null);
        router.refresh();
        return;
      }
      setPreview(null);
      setError(
        sanitizePublicCopy(outcome.result.note ?? "") ||
          "The subscription was created but is not paid. A card form did not open, so the first invoice cannot be confirmed here.",
      );
    } catch (err) {
      setError(publicErrorMessage(err, "Plan change failed."));
    } finally {
      setBusyPlan(null);
    }
  }

  async function onCancel() {
    setCancelBusy(true);
    setError(null);
    try {
      const outcome = await cancelSubscription();
      if (!outcome.ok) {
        setError("Cancellation could not be scheduled.");
        return;
      }
      const ends = outcome.result?.endsAt
        ? new Date(outcome.result.endsAt).toLocaleDateString()
        : "the end of the billing period";
      setMessage(`Cancellation scheduled. You keep access until ${ends}.`);
      setCancelOpen(false);
      router.refresh();
    } catch (err) {
      setError(publicErrorMessage(err, "Cancellation could not be scheduled."));
    } finally {
      setCancelBusy(false);
    }
  }

  const byId = Object.fromEntries(plans.map((p) => [p.planId, p])) as Record<
    PlanId,
    PlanCatalogItem
  >;

  return (
    <section className="space-y-4">
      <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Current subscription</h2>
        <p className="mt-1 text-sm leading-6 text-muted" aria-live="polite">
          {subscription.subscriptionState.message}
          {subscription.subscription?.cancelAtPeriodEnd &&
          subscription.subscription.currentPeriodEnd
            ? ` Access continues until ${new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}.`
            : null}
        </p>
        {unpaid ? (
          <p className="mt-3 rounded-[var(--radius-control)] bg-warning-bg px-3 py-2 text-sm leading-6 text-warning-text">
            This subscription is not paid, so it does not grant a plan. After you
            confirm a plan, enter the card on that card — there is no separate
            Stripe Checkout page.
          </p>
        ) : null}
        {subscription.subscription?.entitlesPlan &&
        !subscription.subscription.cancelAtPeriodEnd ? (
          <div className="mt-4">
            <Button type="button" variant="secondary" onClick={() => setCancelOpen(true)}>
              Cancel at period end
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Plans</h2>
          <p className="mt-1 text-sm leading-6 text-muted">{pricingNote}</p>
        </div>
        <div className="flex rounded-[var(--radius-control)] border border-border p-0.5 text-sm">
          {(["month", "year"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 ${
                interval === value
                  ? "bg-hover font-medium text-foreground"
                  : "text-muted"
              }`}
              onClick={() => {
                setInterval(value);
                setPreview(null);
                setPay(null);
              }}
            >
              {value === "month" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {PLAN_ORDER.map((planId) => {
          const plan = byId[planId];
          if (!plan) return null;
          const price =
            interval === "year" ? plan.annualPerMonthMinor : plan.monthlyPriceMinor;
          const isCurrent = current === planId;
          const retryBlocked = unpaidPlanId === planId;
          const showingPreview = preview?.planId === planId;
          const showingPay = pay?.planId === planId;
          return (
            <article
              key={planId}
              className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold capitalize text-foreground">
                  {planId}
                </h3>
                {isCurrent ? (
                  <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                    Current
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                {formatMinor(price, currency)}
                <span className="text-sm font-normal text-muted"> / mo</span>
              </p>
              <ul className="mt-4 space-y-1.5 text-sm text-muted">
                <li>
                  Threshold{" "}
                  {formatMinor(plan.gmvThresholdMinor, currency)} trailing sales
                </li>
                <li>
                  {plan.storeLimit} store{plan.storeLimit === 1 ? "" : "s"}
                </li>
                <li>
                  {plan.staffSeatLimit == null
                    ? "Unlimited seats"
                    : `${plan.staffSeatLimit} seats`}
                </li>
              </ul>

              {showingPay && pay ? (
                <div className="mt-5 space-y-3">
                  <p className="text-sm text-muted">
                    Enter a card to pay the first invoice. Card details go to Stripe
                    only.
                  </p>
                  <SubscriptionPayForm
                    clientSecret={pay.clientSecret}
                    publishableKey={pay.publishableKey}
                    onDone={() => {
                      setMessage(
                        "Payment submitted. Access updates when Stripe confirms the invoice.",
                      );
                      setPay(null);
                      router.refresh();
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busyPlan !== null}
                    onClick={() => setPay(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : showingPreview && preview ? (
                <div className="mt-5 space-y-3">
                  <h4 className="text-sm font-semibold text-foreground">
                    Confirm plan
                  </h4>
                  <p className="text-sm text-muted">
                    Amount due now:{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {formatMinor(
                        preview.preview.amountDueMinor,
                        preview.preview.currency,
                      )}
                    </span>
                    . This is Stripe&apos;s amount, not a local estimate.
                  </p>
                  <ul className="space-y-1 text-sm text-muted">
                    {preview.preview.lines.map((line) => (
                      <li key={line.description} className="flex justify-between gap-4">
                        <span>{line.description}</span>
                        <span className="tabular-nums">
                          {formatMinor(line.amountMinor, preview.preview.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={busyPlan !== null}
                      onClick={() => void confirmChange()}
                    >
                      {busyPlan ? "Applying…" : "Confirm"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busyPlan !== null}
                      onClick={() => setPreview(null)}
                    >
                      Back
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  className="mt-5 w-full"
                  variant={isCurrent || retryBlocked ? "secondary" : "primary"}
                  disabled={isCurrent || retryBlocked || busyPlan !== null || pay !== null}
                  onClick={() => void requestPreview(planId)}
                >
                  {busyPlan === planId
                    ? "Loading preview…"
                    : isCurrent
                      ? "Current plan"
                      : retryBlocked
                        ? "Payment pending"
                        : current
                          ? "Switch plan"
                          : "Subscribe"}
                </Button>
              )}
            </article>
          );
        })}
      </div>

      {error ? <p className="text-sm text-error-text">{error}</p> : null}
      {message ? <p className="text-sm text-success-text">{message}</p> : null}

      <ConfirmDialog
        open={cancelOpen}
        title="Cancel subscription?"
        description={
          subscription.subscription?.currentPeriodEnd
            ? `You keep access until ${new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}. Cancellation never ends immediately.`
            : "You keep access until the end of the current billing period. Cancellation never ends immediately."
        }
        confirmLabel="Schedule cancellation"
        danger
        busy={cancelBusy}
        onConfirm={() => void onCancel()}
        onClose={() => !cancelBusy && setCancelOpen(false)}
      />
    </section>
  );
}
