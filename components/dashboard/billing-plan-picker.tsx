"use client";

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
import { ApiClientError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const PLAN_ORDER: PlanId[] = ["starter", "growth", "scale"];

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
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [busyPlan, setBusyPlan] = useState<PlanId | null>(null);
  const [preview, setPreview] = useState<{
    planId: PlanId;
    preview: PlanChangePreview;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  const current =
    subscription.subscription?.entitlesPlan === true
      ? subscription.subscription.planId
      : null;

  async function requestPreview(planId: PlanId) {
    setBusyPlan(planId);
    setError(null);
    setMessage(null);
    try {
      const outcome = await updateSubscription({ planId, interval });
      if (!outcome.ok || !outcome.result?.preview) {
        setError(outcome.result?.note ?? "Could not load a proration preview.");
        return;
      }
      setPreview({ planId, preview: outcome.result.preview });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan change failed.");
    } finally {
      setBusyPlan(null);
    }
  }

  async function confirmChange() {
    if (!preview) return;
    setBusyPlan(preview.planId);
    setError(null);
    try {
      const outcome = await updateSubscription({
        planId: preview.planId,
        interval,
        confirm: true,
      });
      if (!outcome.ok) {
        setError(outcome.result?.note ?? "Could not apply the plan change.");
        return;
      }
      setMessage(
        outcome.result?.note ??
          "Plan change submitted. Refresh if the plan does not update right away.",
      );
      setPreview(null);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan change failed.");
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
      window.location.reload();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Cancellation could not be scheduled.",
      );
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
              onClick={() => setInterval(value)}
            >
              {value === "month" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-muted" aria-live="polite">
        {subscription.subscriptionState.message}
        {subscription.subscription?.cancelAtPeriodEnd &&
        subscription.subscription.currentPeriodEnd
          ? ` Access continues until ${new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}.`
          : null}
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        {PLAN_ORDER.map((planId) => {
          const plan = byId[planId];
          if (!plan) return null;
          const price =
            interval === "year" ? plan.annualPerMonthMinor : plan.monthlyPriceMinor;
          const isCurrent = current === planId;
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
              <Button
                type="button"
                className="mt-5 w-full"
                variant={isCurrent ? "secondary" : "primary"}
                disabled={isCurrent || busyPlan !== null}
                onClick={() => void requestPreview(planId)}
              >
                {busyPlan === planId
                  ? "Loading preview…"
                  : isCurrent
                    ? "Current plan"
                    : current
                      ? "Switch plan"
                      : "Subscribe"}
              </Button>
            </article>
          );
        })}
      </div>

      {preview ? (
        <div className="rounded-[var(--radius-card)] border border-border bg-surface-elevated p-5">
          <h3 className="text-sm font-semibold text-foreground">
            Confirm plan change
          </h3>
          <p className="mt-1 text-sm text-muted">
            Amount due now:{" "}
            <span className="font-medium text-foreground tabular-nums">
              {formatMinor(preview.preview.amountDueMinor, preview.preview.currency)}
            </span>
            . This is Stripe&apos;s proration, not a local estimate.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            {preview.preview.lines.map((line) => (
              <li key={line.description} className="flex justify-between gap-4">
                <span>{line.description}</span>
                <span className="tabular-nums">
                  {formatMinor(line.amountMinor, preview.preview.currency)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busyPlan !== null}
              onClick={() => void confirmChange()}
            >
              {busyPlan ? "Applying…" : "Confirm change"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busyPlan !== null}
              onClick={() => setPreview(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {subscription.subscription?.entitlesPlan &&
      !subscription.subscription.cancelAtPeriodEnd ? (
        <div>
          <Button type="button" variant="secondary" onClick={() => setCancelOpen(true)}>
            Cancel at period end
          </Button>
        </div>
      ) : null}

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
