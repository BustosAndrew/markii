import Link from "next/link";
import { FetchError } from "@/components/dashboard/fetch-error";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { LocalDateTime } from "@/components/ui/local-date";
import { PageHeader } from "@/components/ui/page-header";
import { firstParam, loadOrError } from "@/lib/api/load";
import { getPlatformSignups } from "@/lib/api/server";

const WINDOWS = [1, 3, 7, 30];

export default async function AdminSignupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Number(firstParam(sp.days) ?? 1);
  const days = WINDOWS.includes(raw) ? raw : 1;
  const signups = await loadOrError(() => getPlatformSignups(days));

  return (
    <div>
      <PageHeader
        title="Sign-ups"
        description="The same grouping the daily digest mails, on demand. A domain over the threshold is a lead, not a verdict — an agency onboarding clients looks exactly like a disposable-mail service."
        actions={
          <div className="flex gap-1 text-sm">
            {WINDOWS.map((d) => (
              <Link
                key={d}
                href={`/admin/signups?days=${d}`}
                aria-current={d === days ? "page" : undefined}
                className={
                  "rounded-[var(--radius-control)] px-3 py-1.5 " +
                  (d === days ? "bg-hover font-medium text-foreground" : "text-muted hover:bg-hover-soft")
                }
              >
                {d === 1 ? "24h" : `${d}d`}
              </Link>
            ))}
          </div>
        }
      />

      {signups.error || !signups.data ? (
        <FetchError message={signups.error ?? "Unavailable"} />
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-base font-medium text-foreground">
              Domains with {signups.data.threshold} or more{" "}
              <span className="font-normal text-muted">
                · {signups.data.total} sign-up{signups.data.total === 1 ? "" : "s"} in the window
              </span>
            </h2>
            {signups.data.bursts.length === 0 ? (
              <EmptyState
                title="Nothing over the threshold"
                description="The platform's own domain is never counted. The full list is below."
              />
            ) : (
              <div className="space-y-4">
                {signups.data.bursts.map((b) => (
                  <div key={b.domain} className="rounded-[var(--radius-card)] border border-warning-border bg-surface">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                      <span className="font-medium text-foreground">{b.domain}</span>
                      <Badge variant="warning">{b.count} sign-ups</Badge>
                    </div>
                    <ul className="divide-y divide-border text-sm">
                      {b.orgs.map((o) => (
                        <li key={o.slug} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                          <span className="whitespace-nowrap text-muted">
                            <LocalDateTime value={o.createdAt} />
                          </span>
                          <span className="text-muted">{o.email}</span>
                          <Link href={`/admin/orgs/${o.slug}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                            {o.name}
                          </Link>
                          <span className="text-xs text-muted">{o.slug}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-base font-medium text-foreground">All sign-ups in the window</h2>
            {signups.data.recent.length === 0 ? (
              <EmptyState title="No sign-ups" description="Nobody created an organization in this window." />
            ) : (
              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-4 py-3">When</th>
                      <th className="px-4 py-3">Organization</th>
                      <th className="px-4 py-3">Email</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signups.data.recent.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-4 py-3 whitespace-nowrap text-muted">
                          <LocalDateTime value={r.createdAt} />
                        </td>
                        <td className="px-4 py-3">
                          <Link href={`/admin/orgs/${r.slug}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                            {r.name}
                          </Link>{" "}
                          <span className="text-xs text-muted">{r.slug}</span>{" "}
                          {r.suspended ? <Badge variant="error">Suspended</Badge> : null}
                        </td>
                        <td className="px-4 py-3 text-muted">{r.billingEmail}</td>
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
