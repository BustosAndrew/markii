import {
  getBillingAddon,
  getBillingSubscription,
  getBillingUsage,
  listBillingInvoices,
  listBillingPlans,
} from "@/lib/api/server";
import { isConfigurationRequired, isPlannedError } from "@/lib/api/planned";
import type {
  AddonResponse,
  InvoicesResponse,
  PlansResponse,
  SubscriptionResponse,
  UsageResponse,
} from "@/lib/api/billing";
import { BillingInvoices } from "@/components/dashboard/billing-invoices";
import { BillingPlanPicker } from "@/components/dashboard/billing-plan-picker";
import { PaymentMethodForm } from "@/components/dashboard/payment-method-form";
import { ThresholdMeter } from "@/components/dashboard/threshold-meter";
import { SettingsShell } from "@/components/dashboard/settings-shell";

async function loadSafe<T>(fn: () => Promise<T>): Promise<{
  data: T | null;
  error: string | null;
  configurationRequired: boolean;
}> {
  try {
    return { data: await fn(), error: null, configurationRequired: false };
  } catch (caught) {
    if (isPlannedError(caught)) {
      return { data: null, error: caught.message, configurationRequired: false };
    }
    if (isConfigurationRequired(caught)) {
      return {
        data: null,
        error: caught.message,
        configurationRequired: true,
      };
    }
    return {
      data: null,
      error: caught instanceof Error ? caught.message : "Could not load.",
      configurationRequired: false,
    };
  }
}

export default async function SettingsBillingPage() {
  const [plans, subscription, usage, invoices, agentOps, chargeback] =
    await Promise.all([
      loadSafe<PlansResponse>(() => listBillingPlans()),
      loadSafe<SubscriptionResponse>(() => getBillingSubscription()),
      loadSafe<UsageResponse>(() => getBillingUsage()),
      loadSafe<InvoicesResponse>(() => listBillingInvoices({ limit: 20 })),
      loadSafe<AddonResponse>(() => getBillingAddon("agentOps")),
      loadSafe<AddonResponse>(() => getBillingAddon("chargebackAssist")),
    ]);

  const addons = [agentOps.data, chargeback.data].filter(
    (a): a is AddonResponse => a != null,
  );

  return (
    <SettingsShell
      title="Billing"
      description="Your plan, threshold meter, payment method, and invoices."
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
            pricingNote={plans.data.note}
            subscription={subscription.data}
          />
        ) : plans.error && !plans.configurationRequired ? (
          <p className="text-sm text-error-text">{plans.error}</p>
        ) : null}

        <ThresholdMeter
          usage={usage.data}
          planned={false}
          error={
            usage.configurationRequired
              ? usage.error
              : usage.error
          }
        />

        {subscription.data ? (
          <PaymentMethodForm
            paymentMethod={subscription.data.subscription?.paymentMethod ?? null}
          />
        ) : null}

        {addons.length > 0 ? (
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
            <h2 className="text-base font-medium text-foreground">Add-ons</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Shown for awareness. Purchase is unavailable until the products exist.
            </p>
            <ul className="mt-4 space-y-4">
              {addons.map((addon) => (
                <li key={addon.addon}>
                  <p className="font-medium text-foreground">{addon.label}</p>
                  <p className="mt-1 text-sm text-muted">
                    {addon.includedInPlan
                      ? "Included in your plan."
                      : addon.purchased
                        ? "Purchased."
                        : addon.availability.message}
                  </p>
                  {!addon.includedInPlan && !addon.purchased ? (
                    <p className="mt-1 text-xs text-muted-soft">
                      {addon.availability.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {invoices.data ? (
          <BillingInvoices data={invoices.data} />
        ) : invoices.error && !invoices.configurationRequired ? (
          <p className="text-sm text-error-text">{invoices.error}</p>
        ) : null}
      </div>
    </SettingsShell>
  );
}
