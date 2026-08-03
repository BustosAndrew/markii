import { listMembershipTiers, listSites } from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { MembershipTiers } from "@/components/dashboard/membership-tiers";
import { FetchError } from "@/components/dashboard/fetch-error";
import { PageHeader } from "@/components/ui/page-header";

/**
 * `/dashboard/memberships` (§18.9).
 *
 * Membership tiers gate products and are conferred by buying one. This screen is
 * the merchant's side of that: what exists, how many people hold it, and how
 * much of the catalogue it unlocks.
 *
 * Counts come from the API computed per request, never stored — a membership
 * lapses by the clock and nothing here schedules a job to notice, so a cached
 * "active members" figure would drift upward forever.
 */
export default async function MembershipsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;

  const [tiers, sites] = await Promise.all([
    loadOrError(() => listMembershipTiers(siteId ? { siteId } : undefined)),
    loadOrError(() => listSites({ limit: 100 })),
  ]);

  return (
    <div>
      <PageHeader
        title="Memberships"
        description="Tiers that gate products, and who currently holds them. Memberships are bought for a fixed term and do not renew automatically."
      />

      {tiers.data ? (
        <MembershipTiers
          tiers={tiers.data.items}
          sites={(sites.data?.items ?? []).map((s) => ({ id: s.id, name: s.name }))}
          selectedSiteId={siteId ?? null}
        />
      ) : (
        <FetchError message={tiers.error ?? "Membership tiers could not be loaded."} />
      )}
    </div>
  );
}
