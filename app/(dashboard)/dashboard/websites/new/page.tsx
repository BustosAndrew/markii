import { getMe, listSites } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { CreateWebsiteWizard } from "@/components/dashboard/create-website-wizard";

export default async function NewWebsitePage() {
  const [sitesResult, meResult] = await Promise.all([
    loadOrError(() => listSites({ limit: 100, sort: "name" })),
    loadOrError(() => getMe()),
  ]);

  /**
   * The organization's currency prices hand-added and template products. Any
   * three-letter code works now that display and checkout both read
   * `priceCents` in the currency's own minor unit (D49).
   */
  const orgCurrency = meResult.data?.org.currency?.toUpperCase() ?? "USD";
  const usable = /^[A-Z]{3}$/.test(orgCurrency);

  return (
    <CreateWebsiteWizard
      sites={sitesResult.data?.items ?? []}
      orgCurrency={usable ? orgCurrency : "USD"}
    />
  );
}
