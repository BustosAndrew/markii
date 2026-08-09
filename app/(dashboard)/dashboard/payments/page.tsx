import { getPayments } from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { PageHeader } from "@/components/ui/page-header";
import { FetchError } from "@/components/dashboard/fetch-error";
import { PaymentsPanel } from "@/components/dashboard/payments-panel";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stripeFlash = firstParam(sp.stripe);
  const flashReason = firstParam(sp.reason);

  const { data, error } = await loadOrError(() => getPayments());

  const flash =
    stripeFlash === "connected" ||
    stripeFlash === "cancelled" ||
    stripeFlash === "error"
      ? stripeFlash
      : null;

  return (
    <div>
      <PageHeader
        title="Payments"
        description="Where money is paid — Stripe and x402. Catalog feeds live under Integrations."
      />

      {error || !data ? (
        <FetchError
          title="Payments unavailable"
          message={error ?? "Could not load payment rails."}
        />
      ) : (
        <PaymentsPanel
          initial={data}
          flash={flash}
          flashReason={flashReason}
        />
      )}
    </div>
  );
}
