import Link from "next/link";
import { FetchError } from "@/components/dashboard/fetch-error";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { LocalDate } from "@/components/ui/local-date";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import type { AccountStanding } from "@/lib/api/billing";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { listPlatformOrgs } from "@/lib/api/server";

function StandingBadge({ standing }: { standing: AccountStanding }) {
  switch (standing.state) {
    case "suspended":
      return <Badge variant="error">Suspended</Badge>;
    case "expired":
      return <Badge variant="warning">Trial ended</Badge>;
    case "past_due":
      return <Badge variant="warning">Past due · {standing.dunning.step.replace("_", " ")}</Badge>;
    case "trialing":
      return <Badge variant="info">Trial · {standing.daysLeft}d left</Badge>;
    case "subscribed":
      return <Badge variant="success">Subscribed</Badge>;
    default:
      return <Badge variant="neutral">{standing.state}</Badge>;
  }
}

export default async function AdminOrgsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const suspendedRaw = firstParam(sp.suspended);
  const query = {
    q: firstParam(sp.q) || undefined,
    suspended: suspendedRaw === "true" ? true : suspendedRaw === "false" ? false : undefined,
    page: parsePage(sp.page),
    limit: parseLimit(sp.limit),
  };
  const list = await loadOrError(() => listPlatformOrgs(query));

  return (
    <div>
      <PageHeader
        title="Organizations"
        description="Every merchant organization, newest first. Search by name, slug or sign-up email."
      />
      <ListFilters
        searchPlaceholder="Name, slug or email…"
        filters={[
          {
            key: "suspended",
            label: "Standing",
            options: [
              { value: "", label: "All" },
              { value: "true", label: "Suspended" },
              { value: "false", label: "Not suspended" },
            ],
          },
        ]}
        className="mb-4"
      />
      {list.error || !list.data ? (
        <FetchError message={list.error ?? "Unavailable"} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title="No organizations match" description="Try a broader search, or clear the filter." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-3">Organization</th>
                  <th className="px-4 py-3">Sign-up email</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Standing</th>
                  <th className="px-4 py-3">Stores</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((o) => (
                  <tr key={o.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <Link href={`/admin/orgs/${o.slug}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                        {o.name}
                      </Link>
                      <div className="text-xs text-muted">{o.slug}</div>
                    </td>
                    <td className="px-4 py-3 text-muted">{o.billingEmail}</td>
                    <td className="px-4 py-3 capitalize text-muted">{o.planId}</td>
                    <td className="px-4 py-3">
                      <StandingBadge standing={o.standing} />
                    </td>
                    <td className="px-4 py-3 text-muted">{o.storeCount}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted">
                      <LocalDate value={o.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data.page} limit={list.data.limit} total={list.data.total} className="mt-4" />
        </>
      )}
    </div>
  );
}
