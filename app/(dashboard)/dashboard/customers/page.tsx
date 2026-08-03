import Link from "next/link";
import { getMe, listCustomers, listSites } from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { formatMinor } from "@/lib/api/money";
import { FetchError } from "@/components/dashboard/fetch-error";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";

/**
 * `/dashboard/customers` (§18.3).
 *
 * `ordersCount` and `totalSpentMinor` are **derived by the API, never stored** —
 * a denormalised total drifts after the first refund, and then this list
 * disagrees with the orders list.
 *
 * Money is formatted from the **org's** currency (D31), never a hardcoded
 * `/100`: `Organization.currency` is merchant-set, so JPY and KRW would render
 * 100× wrong under a fixed two-decimal assumption.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const [customers, sites, me] = await Promise.all([
    loadOrError(() => listCustomers({ q, siteId, page, limit })),
    loadOrError(() => listSites({ limit: 100 })),
    loadOrError(() => getMe()),
  ]);

  const currency = me.data?.org.currency ?? "USD";

  return (
    <div>
      <PageHeader
        title="Customers"
        description="Everyone who has ordered from or created an account at one of your stores."
      />

      <ListFilters
        searchPlaceholder="Search email or name…"
        filters={
          sites.data && sites.data.items.length > 1
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
            : undefined
        }
      />

      {!customers.data ? (
        <FetchError message={customers.error ?? "Customers could not be loaded."} />
      ) : customers.data.items.length === 0 ? (
        <EmptyState
          title={q ? "No customers matched" : "No customers yet"}
          description={
            q
              ? "Try a different email or name."
              : "A customer record appears the first time someone orders or creates an account at one of your stores."
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Marketing</th>
                  <th className="px-4 py-3 font-medium">Orders</th>
                  <th className="px-4 py-3 font-medium">Total spent</th>
                  <th className="px-4 py-3 font-medium">First seen</th>
                </tr>
              </thead>
              <tbody>
                {customers.data.items.map((c) => {
                  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
                  return (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <Link
                          href={`/dashboard/customers/${c.id}`}
                          className="font-medium text-foreground hover:text-brand"
                        >
                          {c.email}
                        </Link>
                        {name ? <div className="text-xs text-muted">{name}</div> : null}
                      </td>
                      <td className="px-4 py-3">
                        {/*
                          Consent is given, never assumed (§18.3), so the absent
                          case is shown as absent rather than as a quiet "no".
                        */}
                        {c.acceptsMarketing ? (
                          <Badge variant="success">Opted in</Badge>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-foreground">{c.ordersCount}</td>
                      <td className="px-4 py-3 tabular-nums text-foreground">
                        {formatMinor(c.totalSpentMinor, currency)}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {new Date(c.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={customers.data.page}
            limit={customers.data.limit}
            total={customers.data.total}
          />
        </>
      )}
    </div>
  );
}
