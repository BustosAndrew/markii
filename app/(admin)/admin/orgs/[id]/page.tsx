import Link from "next/link";
import { SuspendControls } from "@/components/admin/suspend-controls";
import { FetchError } from "@/components/dashboard/fetch-error";
import { Badge } from "@/components/ui/badge";
import { LocalDateTime } from "@/components/ui/local-date";
import { PageHeader } from "@/components/ui/page-header";
import { StatusDot } from "@/components/ui/status-dot";
import { loadOrError } from "@/lib/api/load";
import { getPlatformOrg } from "@/lib/api/server";

export default async function AdminOrgPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await loadOrError(() => getPlatformOrg(id));

  if (org.error || !org.data) {
    return (
      <div>
        <PageHeader title="Organization" />
        <FetchError message={org.error ?? "Not found"} />
      </div>
    );
  }
  const o = org.data;

  return (
    <div>
      <PageHeader
        title={o.name}
        description={`${o.slug} · ${o.billingEmail}`}
        actions={
          <Link href="/admin/orgs" className="text-sm text-muted underline-offset-2 hover:underline">
            All organizations
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div className="space-y-6">
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <h2 className="text-base font-medium text-foreground">Standing</h2>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
              <dt className="text-muted">State</dt>
              <dd>
                <Badge
                  variant={
                    o.standing.state === "suspended"
                      ? "error"
                      : o.standing.state === "expired" || o.standing.state === "past_due"
                        ? "warning"
                        : o.standing.state === "subscribed"
                          ? "success"
                          : "info"
                  }
                >
                  {o.standing.state.replace("_", " ")}
                </Badge>
              </dd>
              <dt className="text-muted">What they see</dt>
              <dd className="text-foreground">{o.standing.message}</dd>
              <dt className="text-muted">Plan</dt>
              <dd className="capitalize text-foreground">{o.planId}</dd>
              <dt className="text-muted">Signed up</dt>
              <dd className="text-foreground">
                <LocalDateTime value={o.createdAt} />
              </dd>
              <dt className="text-muted">Org id</dt>
              <dd>
                <code className="text-xs text-muted">{o.id}</code>
              </dd>
            </dl>
          </section>

          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <h2 className="text-base font-medium text-foreground">Stores</h2>
            {o.stores.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No storefronts yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border text-sm">
                {o.stores.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex items-center gap-2">
                      <StatusDot tone={s.status} label={s.status} />
                      <span className="font-medium text-foreground">{s.name}</span>
                      <span className="text-muted">{s.slug}</span>
                    </span>
                    <span className="capitalize text-muted">{s.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <SuspendControls org={o} />
      </div>
    </div>
  );
}
