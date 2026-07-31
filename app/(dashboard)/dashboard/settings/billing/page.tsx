import { getBillingUsage, type UsageResponse } from "@/lib/api/billing";
import { isPlannedError } from "@/lib/api/planned";
import { ThresholdMeter } from "@/components/dashboard/threshold-meter";
import { ComingSoon } from "@/components/ui/coming-soon";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export default async function SettingsBillingPage() {
  let planned = false;
  let error: string | null = null;
  let usage: UsageResponse | null = null;

  try {
    usage = await getBillingUsage();
  } catch (caught) {
    if (isPlannedError(caught)) {
      planned = true;
    } else if (caught instanceof Error) {
      error = caught.message;
    } else {
      error = "Billing usage could not be loaded.";
    }
  }

  return (
    <SettingsShell
      title="Billing"
      description="Plan structure, threshold metering, and invoice history stay visible here before billing APIs are live."
    >
      <div className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-3">
          {["Starter", "Growth", "Scale"].map((plan) => (
            <section
              key={plan}
              className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]"
            >
              <h2 className="text-base font-medium text-foreground">{plan}</h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                Pricing is still being finalized. This shell stays intentionally factual until the plan catalog is live.
              </p>
            </section>
          ))}
        </div>

        <ThresholdMeter usage={usage} planned={planned} error={error} />

        <ComingSoon
          title="Invoices will appear here"
          description="Invoice history, payment method details, and add-ons will populate when billing subscriptions and invoicing APIs are live."
          apiSection="API §17 · Billing invoices and subscription lifecycle"
        />
      </div>
    </SettingsShell>
  );
}
