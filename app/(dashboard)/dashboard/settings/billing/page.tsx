import {
  getBillingAddon,
  getBillingUsage,
  listBillingInvoices,
} from "@/lib/api/server";
import { loadConfigured } from "@/lib/api/load";
import { sanitizePublicCopy } from "@/lib/api/public-copy";
import type {
  AddonResponse,
  InvoicesResponse,
  UsageResponse,
} from "@/lib/api/billing";
import { BillingInvoices } from "@/components/dashboard/billing-invoices";
import { ThresholdMeter } from "@/components/dashboard/threshold-meter";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export default async function SettingsBillingPage() {
  const [usage, invoices, agentOps, chargeback] = await Promise.all([
    loadConfigured<UsageResponse>(() => getBillingUsage()),
    loadConfigured<InvoicesResponse>(() => listBillingInvoices({ limit: 20 })),
    loadConfigured<AddonResponse>(() => getBillingAddon("agentOps")),
    loadConfigured<AddonResponse>(() => getBillingAddon("chargebackAssist")),
  ]);

  const addons = [agentOps.data, chargeback.data].filter(
    (a): a is AddonResponse => a != null,
  );

  return (
    <SettingsShell
      title="Billing"
      description="Threshold meter, invoices, and fee assessments. Plan and card live under Subscription."
    >
      <div className="space-y-8">
        {usage.configurationRequired ? (
          <p className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4 text-sm text-muted">
            Billing is not configured on this deployment yet
            {usage.error ? `: ${usage.error}` : "."}
          </p>
        ) : (
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
    </SettingsShell>
  );
}
