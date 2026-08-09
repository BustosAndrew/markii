import { getIntegrations } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { PageHeader } from "@/components/ui/page-header";
import { FetchError } from "@/components/dashboard/fetch-error";
import { IntegrationsPanel } from "@/components/dashboard/integrations-panel";

export default async function IntegrationsPage() {
  const { data, error } = await loadOrError(() =>
    getIntegrations(),
  );

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect the payment and catalog tools your store uses. Stripe, x402, and Google Merchant Center are peer options."
      />

      {error || !data ? (
        <FetchError
          title="Integrations unavailable"
          message={error ?? "Could not load integration status."}
        />
      ) : (
        <IntegrationsPanel initial={data} />
      )}
    </div>
  );
}
