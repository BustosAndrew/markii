import { loadOrError } from "@/lib/api/load";
import { listSites, getMe } from "@/lib/api/server";
import { FetchError } from "@/components/dashboard/fetch-error";
import { DiscountForm } from "@/components/dashboard/discount-form";
import { PageHeader } from "@/components/ui/page-header";

export default async function NewDiscountPage() {
  const [sitesResult, meResult] = await Promise.all([
    loadOrError(() => listSites({ limit: 100, sort: "name" })),
    loadOrError(() => getMe()),
  ]);

  if (sitesResult.error || !sitesResult.data) {
    return (
      <div>
        <PageHeader title="New discount" />
        <FetchError
          title="Cannot create discount"
          message={sitesResult.error ?? "Sites are required before creating a discount."}
        />
      </div>
    );
  }

  const currency = meResult.data?.org.currency ?? "USD";

  return (
    <div>
      <PageHeader
        title="New discount"
        description="Create a code or automatic promotion. Percentages are stored as basis points."
      />
      <DiscountForm mode="create" sites={sitesResult.data.items} currency={currency} />
    </div>
  );
}
