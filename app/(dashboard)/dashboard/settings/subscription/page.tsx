import { getBillingSubscription, listBillingPlans } from "@/lib/api/server";
import { loadConfigured } from "@/lib/api/load";
import { sanitizePublicCopy } from "@/lib/api/public-copy";
import type { PlansResponse, SubscriptionResponse } from "@/lib/api/billing";
import { BillingPlanPicker } from "@/components/dashboard/billing-plan-picker";
import { PaymentMethodForm } from "@/components/dashboard/payment-method-form";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export default async function SettingsSubscriptionPage() {
  const [plans, subscription] = await Promise.all([
    loadConfigured<PlansResponse>(() => listBillingPlans()),
    loadConfigured<SubscriptionResponse>(() => getBillingSubscription()),
  ]);

  const granted = subscription.data?.subscription?.entitlesPlan === true;

  return (
    <SettingsShell
      title="Subscription"
      description="Choose a plan and pay the first invoice on the plan card. Card on file is for renewals."
    >
      <div className="space-y-8">
        {subscription.configurationRequired || plans.configurationRequired ? (
          <p className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4 text-sm text-muted">
            Billing is not configured on this deployment yet
            {subscription.error ? `: ${subscription.error}` : "."}
          </p>
        ) : null}

        {plans.data && subscription.data ? (
          <BillingPlanPicker
            plans={plans.data.items}
            currency={plans.data.currency}
            pricingNote={
              sanitizePublicCopy(plans.data.note) ||
              "Markii charges no transaction fee below your plan threshold, on any payment provider."
            }
            subscription={subscription.data}
          />
        ) : plans.error && !plans.configurationRequired ? (
          <p className="text-sm text-error-text">{sanitizePublicCopy(plans.error)}</p>
        ) : subscription.error && !subscription.configurationRequired ? (
          <p className="text-sm text-error-text">
            {sanitizePublicCopy(subscription.error)}
          </p>
        ) : null}

        {granted ? (
          <PaymentMethodForm
            paymentMethod={subscription.data?.subscription?.paymentMethod ?? null}
          />
        ) : null}
      </div>
    </SettingsShell>
  );
}
