import {
  getBillingAddon,
  getBillingSubscription,
  getBillingUsage,
  listBillingInvoices,
  listBillingPlans,
} from "@/lib/api/server";
import { loadConfigured } from "@/lib/api/load";
import { sanitizePublicCopy } from "@/lib/api/public-copy";
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
import { PageHeader } from "@/components/ui/page-header";

export default async function BillingPage() {
  const [plans, subscription, usage, invoices, agentOps, chargeback] = await Promise.all([
    loadConfigured<PlansResponse>(() => listBillingPlans()),
    loadConfigured<SubscriptionResponse>(() => getBillingSubscription()),
    loadConfigured<UsageResponse>(() => getBillingUsage()),
    loadConfigured<InvoicesResponse>(() => listBillingInvoices({ limit: 20 })),
    loadConfigured<AddonResponse>(() => getBillingAddon("agentOps")),
    loadConfigured<AddonResponse>(() => getBillingAddon("chargebackAssist")),
  ]);

  const addons = [agentOps.data, chargeback.data].filter(
    (a): a is AddonResponse => a != null,
  );
  const granted = subscription.data?.subscription?.entitlesPlan === true;
  const billingUnconfigured =
    subscription.configurationRequired || plans.configurationRequired;

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Plan, card, threshold meter, and invoices. Changing a plan requires a fresh authenticator code."
      />

      <div className="space-y-10">
        {billingUnconfigured ? (
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

        {usage.configurationRequired ? null : (
          <ThresholdMeter usage={usage.data} planned={false} error={usage.error} />
        )}

        {addons.length > 0 ? (
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
            <h2 className="text-base font-medium text-foreground">Add-ons</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Shown for awareness. These add-ons are not available to purchase yet.
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
                        : sanitizePublicCopy(addon.availability.message) ||
                          "Not available to purchase yet."}
                  </p>
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
    </div>
  );
}
