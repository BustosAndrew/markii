import { getMe, listShippingZones, listSites } from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { FetchError } from "@/components/dashboard/fetch-error";
import { SettingsShell } from "@/components/dashboard/settings-shell";
import { ShippingSettings } from "@/components/dashboard/shipping-settings";

const DESCRIPTION =
  "Shipping zones match shopper destinations; rates within a zone are what checkout quotes at purchase time.";

export default async function SettingsShippingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const [sitesResult, meResult] = await Promise.all([
    loadOrError(() => listSites({ limit: 100, sort: "name" })),
    loadOrError(() => getMe()),
  ]);

  const sites = (sitesResult.data?.items ?? []).map((s) => ({ id: s.id, name: s.name }));
  const currency = meResult.data?.org.currency ?? "USD";

  if (sites.length === 0) {
    return (
      <SettingsShell title="Shipping" description={DESCRIPTION}>
        <FetchError message={sitesResult.error ?? "No storefronts found."} />
      </SettingsShell>
    );
  }

  const siteIdRaw = firstParam(sp.siteId);
  const parsedSiteId = siteIdRaw ? Number(siteIdRaw) : sites[0]!.id;
  const siteId = sites.some((s) => s.id === parsedSiteId) ? parsedSiteId : sites[0]!.id;

  const zonesResult = await loadOrError(() => listShippingZones(siteId));

  return (
    <SettingsShell title="Shipping" description={DESCRIPTION}>
      {zonesResult.data ? (
        <ShippingSettings
          key={`ship-${siteId}-${zonesResult.data.items.map((z) => z.id).join("-")}-${zonesResult.data.total}`}
          sites={sites}
          siteId={siteId}
          currency={currency}
          zones={zonesResult.data.items}
        />
      ) : (
        <FetchError message={zonesResult.error ?? "Shipping zones could not be loaded."} />
      )}
    </SettingsShell>
  );
}
