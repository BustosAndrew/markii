import { getMe, listSites } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { currencyExponent } from "@/lib/api/money";
import { CreateWebsiteWizard } from "@/components/dashboard/create-website-wizard";

export default async function NewWebsitePage() {
  const [sitesResult, meResult] = await Promise.all([
    loadOrError(() => listSites({ limit: 100, sort: "name" })),
    loadOrError(() => getMe()),
  ]);

  /**
   * The organization's currency prices hand-added products — but only when it
   * has two decimals. `priceCents` is displayed ÷100 yet charged in the
   * currency's own minor unit (D49, open), so a yen product would show ¥1,500
   * and charge ¥150,000. Until that is fixed such orgs keep the old USD
   * default: mislabelled, but charged as displayed.
   */
  const orgCurrency = meResult.data?.org.currency?.toUpperCase() ?? "USD";
  const usable = /^[A-Z]{3}$/.test(orgCurrency) && currencyExponent(orgCurrency) === 2;

  return (
    <CreateWebsiteWizard
      sites={sitesResult.data?.items ?? []}
      orgCurrency={usable ? orgCurrency : "USD"}
    />
  );
}
