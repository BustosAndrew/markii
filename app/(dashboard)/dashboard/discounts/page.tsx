import { getMe, listDiscounts, listSites } from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { formatMinor } from "@/lib/api/money";
import type { Discount } from "@/lib/api/commerce";
import { FetchError } from "@/components/dashboard/fetch-error";
import { Badge } from "@/components/ui/badge";
import { ComingSoon } from "@/components/ui/coming-soon";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";

const STATUS_VARIANT: Record<Discount["status"], "success" | "warning" | "error" | "neutral"> = {
  active: "success",
  scheduled: "neutral",
  expired: "warning",
  disabled: "error",
};

/** Percentages are basis points — 1500 is 15%. Never a float (D31). */
function describeValue(d: Discount, currency: string): string {
  if (d.type === "free_shipping") return "Free shipping";
  if (d.type === "percentage") {
    return d.percentageBps != null ? `${d.percentageBps / 100}% off` : "Percentage";
  }
  return d.valueMinor != null ? `${formatMinor(d.valueMinor, currency)} off` : "Fixed";
}

function describeScope(d: Discount): string {
  if (d.appliesToScope === "order") return "Whole order";
  const n = d.appliesToIds.length;
  return `${n} ${d.appliesToScope === "products" ? "product" : "collection"}${n === 1 ? "" : "s"}`;
}

/**
 * `/dashboard/discounts` (§18.5).
 *
 * `status` and `usedCount` are **derived per request**, never stored — a stored
 * status goes stale the moment its window closes, and a drifting redemption
 * count is the difference between a code working and a shopper being refused.
 *
 * Gift cards are **deferred** (D33) and deliberately not represented here.
 */
export default async function DiscountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;
  const statusRaw = firstParam(sp.status);
  const status = (["active", "scheduled", "expired", "disabled"] as const).find(
    (s) => s === statusRaw,
  );
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const [discounts, sites, me] = await Promise.all([
    loadOrError(() => listDiscounts({ siteId, status, page, limit })),
    loadOrError(() => listSites({ limit: 100 })),
    loadOrError(() => getMe()),
  ]);

  const currency = me.data?.org.currency ?? "USD";

  return (
    <div>
      <PageHeader
        title="Discounts"
        description="Codes and automatic promotions. Status is computed from the schedule and the on/off switch, so it is always current."
      />

      <ListFilters
        searchPlaceholder="Search discounts…"
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "active", label: "Active" },
              { value: "scheduled", label: "Scheduled" },
              { value: "expired", label: "Expired" },
              { value: "disabled", label: "Disabled" },
            ],
          },
          ...(sites.data && sites.data.items.length > 1
            ? [
                {
                  key: "siteId",
                  label: "Store",
                  options: sites.data.items.map((s) => ({
                    value: String(s.id),
                    label: s.name,
                  })),
                },
              ]
            : []),
        ]}
      />

      {!discounts.data ? (
        <FetchError message={discounts.error ?? "Discounts could not be loaded."} />
      ) : discounts.data.items.length === 0 ? (
        <EmptyState
          title={status ? `No ${status} discounts` : "No discounts yet"}
          description="Discounts are created through the action registry (§22); a builder screen for them is not built yet."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">Discount</th>
                  <th className="px-4 py-3 font-medium">Value</th>
                  <th className="px-4 py-3 font-medium">Applies to</th>
                  <th className="px-4 py-3 font-medium">Used</th>
                  <th className="px-4 py-3 font-medium">Window</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {discounts.data.items.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{d.title}</div>
                      <div className="text-xs text-muted">
                        {/*
                          A null code means automatic — it applies with nothing
                          typed. An empty cell would read as a missing code
                          rather than a deliberate one.
                        */}
                        {d.code ? (
                          <span className="font-mono">{d.code}</span>
                        ) : (
                          "Automatic — no code needed"
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-foreground">{describeValue(d, currency)}</td>
                    <td className="px-4 py-3 text-muted">{describeScope(d)}</td>
                    <td className="px-4 py-3">
                      <span className="tabular-nums text-foreground">
                        {d.usedCount}
                        {d.usageLimit != null ? ` / ${d.usageLimit}` : ""}
                      </span>
                      {/*
                        An exhausted code still reads as "active" by its dates —
                        it only fails when a shopper tries it. Stated here so the
                        merchant finds out first.
                      */}
                      {d.exhausted ? (
                        <div className="mt-1">
                          <Badge variant="warning">Fully redeemed</Badge>
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {d.startsAt ? new Date(d.startsAt).toLocaleDateString() : "—"}
                      {" → "}
                      {d.endsAt ? new Date(d.endsAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={discounts.data.page}
            limit={discounts.data.limit}
            total={discounts.data.total}
          />
        </>
      )}

      <ComingSoon
        className="mt-6"
        title="Gift cards are not planned right now"
        description="Gift cards were deferred until further notice (docs/DECISIONS.md D33). They are a stored-value tender rather than a discount, so they will not appear on this screen when they do arrive."
        apiSection="Deferred · D33"
      />
    </div>
  );
}
