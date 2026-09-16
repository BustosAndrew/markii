import Link from "next/link";
import { FetchError } from "@/components/dashboard/fetch-error";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { LocalDateTime } from "@/components/ui/local-date";
import { PageHeader } from "@/components/ui/page-header";
import { loadOrError } from "@/lib/api/load";
import { getPlatformOverview } from "@/lib/api/server";

function Stat({ label, value, href, tone }: { label: string; value: number; href: string; tone?: "warning" | "error" }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 transition-colors hover:bg-hover-soft"
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div
        className={
          "mt-1 text-2xl font-semibold " +
          (tone === "error" && value > 0
            ? "text-error-text"
            : tone === "warning" && value > 0
              ? "text-warning-text"
              : "text-foreground")
        }
      >
        {value}
      </div>
    </Link>
  );
}

export default async function AdminOverviewPage() {
  const overview = await loadOrError(() => getPlatformOverview());

  return (
    <div>
      <PageHeader
        title="Platform overview"
        description="Every number here is derived on this request. Nothing is held or disabled by anything on this page — only by an operator, on the organization's own page."
      />
      {overview.error || !overview.data ? (
        <FetchError message={overview.error ?? "Unavailable"} />
      ) : (
        <div className="space-y-8">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Organizations" value={overview.data.orgs} href="/admin/orgs" />
            <Stat label="Suspended" value={overview.data.suspended} href="/admin/orgs?suspended=true" tone="error" />
            <Stat label="Sign-ups, 24h" value={overview.data.signups24h} href="/admin/signups" />
            <Stat
              label={`Domains ≥ ${overview.data.threshold} today`}
              value={overview.data.flaggedDomains}
              href="/admin/signups"
              tone="warning"
            />
          </div>

          <section>
            <h2 className="mb-3 text-base font-medium text-foreground">Recent suspensions</h2>
            {overview.data.recentSuspensions.length === 0 ? (
              <EmptyState title="No organization is suspended" description="Suspensions appear here with their reason, newest first." />
            ) : (
              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-4 py-3">Organization</th>
                      <th className="px-4 py-3">Since</th>
                      <th className="px-4 py-3">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.data.recentSuspensions.map((s) => (
                      <tr key={s.id} className="border-t border-border">
                        <td className="px-4 py-3">
                          <Link href={`/admin/orgs/${s.slug}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                            {s.name}
                          </Link>{" "}
                          <span className="text-muted">({s.slug})</span>{" "}
                          <Badge variant="error">Suspended</Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted">
                          <LocalDateTime value={s.suspendedAt} />
                        </td>
                        <td className="px-4 py-3 text-muted">{s.suspendedReason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
