import { listDigitalAssets, listSites } from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { DigitalAssetsPanel } from "@/components/dashboard/digital-assets-panel";
import { FetchError } from "@/components/dashboard/fetch-error";
import { ListFilters } from "@/components/ui/list-filters";
import { PageHeader } from "@/components/ui/page-header";

export default async function DeliveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;

  const [assetsResult, sitesResult] = await Promise.all([
    loadOrError(() =>
      listDigitalAssets({
        siteId: Number.isFinite(siteId) ? siteId : undefined,
        limit: 100,
      }),
    ),
    loadOrError(() => listSites({ limit: 100, sort: "name" })),
  ]);

  const sites = (sitesResult.data?.items ?? []).map((site) => ({
    id: site.id,
    name: site.name,
  }));

  return (
    <div>
      <PageHeader
        title="Delivery"
        description="Upload the files you sell, review advisory storage and egress usage, and keep assets private until a paid shopper redeems a download grant."
      />

      {sites.length > 1 ? (
        <ListFilters
          filters={[
            {
              key: "siteId",
              label: "All storefronts",
              options: sites.map((site) => ({
                value: String(site.id),
                label: site.name,
              })),
            },
          ]}
        />
      ) : null}

      {assetsResult.data ? (
        <DigitalAssetsPanel
          initial={assetsResult.data}
          sites={sites}
          selectedSiteId={Number.isFinite(siteId) ? siteId ?? null : null}
        />
      ) : (
        <FetchError
          title="Digital delivery unavailable"
          message={assetsResult.error ?? "Digital assets could not be loaded."}
        />
      )}
    </div>
  );
}
