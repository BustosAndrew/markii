import { getMe, getTaxSettings, listSites } from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { FetchError } from "@/components/dashboard/fetch-error";
import { SettingsShell } from "@/components/dashboard/settings-shell";
import { TaxSettingsForm } from "@/components/dashboard/tax-settings-form";

const DESCRIPTION =
  "Configure how tax is calculated at checkout. You remain the seller of record — Markii does not provide tax advice.";

export default async function SettingsTaxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const sitesResult = await loadOrError(() => listSites({ limit: 100, sort: "name" }));
  const sites = (sitesResult.data?.items ?? []).map((s) => ({ id: s.id, name: s.name }));

  if (sites.length === 0) {
    return (
      <SettingsShell title="Tax" description={DESCRIPTION}>
        <FetchError message={sitesResult.error ?? "No storefronts found."} />
      </SettingsShell>
    );
  }

  const siteIdRaw = firstParam(sp.siteId);
  const parsedSiteId = siteIdRaw ? Number(siteIdRaw) : sites[0]!.id;
  const siteId = sites.some((s) => s.id === parsedSiteId) ? parsedSiteId : sites[0]!.id;

  const [taxResult, meResult] = await Promise.all([
    loadOrError(() => getTaxSettings(siteId)),
    loadOrError(() => getMe()),
  ]);

  return (
    <SettingsShell title="Tax" description={DESCRIPTION}>
      {taxResult.data ? (
        <TaxSettingsForm
          key={`tax-${siteId}-${taxResult.data.updatedAt ?? "new"}`}
          sites={sites}
          siteId={siteId}
          settings={taxResult.data}
          currency={meResult.data?.org.currency ?? "USD"}
        />
      ) : (
        <FetchError message={taxResult.error ?? "Tax settings could not be loaded."} />
      )}
    </SettingsShell>
  );
}
