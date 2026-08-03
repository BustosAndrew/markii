import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getCustomer,
  getCustomerMemberships,
  getCustomerOrders,
  getMe,
} from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { formatCents, formatMinor } from "@/lib/api/money";
import type { MembershipStatus } from "@/lib/api/memberships";
import { FetchError } from "@/components/dashboard/fetch-error";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

const STATUS_VARIANT: Record<MembershipStatus, "success" | "warning" | "error" | "neutral"> = {
  active: "success",
  scheduled: "neutral",
  expired: "warning",
  revoked: "error",
};

/**
 * `/dashboard/customers/:id` (§18.3, §18.9).
 *
 * Pulls the record, its memberships, and its orders. Each membership shows a
 * **derived** status — `revoked` and `expired` stay distinct, because "we took
 * it away" and "it ran out" are different answers to the complaint that usually
 * brings a merchant to this page.
 */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const customerId = Number(id);
  if (!Number.isInteger(customerId) || customerId <= 0) notFound();

  const [customer, memberships, orders, me] = await Promise.all([
    loadOrError(() => getCustomer(customerId)),
    loadOrError(() => getCustomerMemberships(customerId)),
    loadOrError(() => getCustomerOrders(customerId, { limit: 20 })),
    loadOrError(() => getMe()),
  ]);

  if (!customer.data) {
    return (
      <div>
        <PageHeader title="Customer" description="" />
        <FetchError message={customer.error ?? "This customer could not be loaded."} />
      </div>
    );
  }

  const c = customer.data;
  const currency = me.data?.org.currency ?? "USD";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");

  return (
    <div>
      <PageHeader
        title={name || c.email}
        description={name ? c.email : "Customer record"}
      />

      <div className="space-y-6">
        <section className="grid gap-4 sm:grid-cols-3">
          <Stat label="Orders" value={String(c.ordersCount)} />
          <Stat label="Total spent" value={formatMinor(c.totalSpentMinor, currency)} />
          <Stat label="First seen" value={new Date(c.createdAt).toLocaleDateString()} />
        </section>

        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-base font-medium text-foreground">Memberships</h2>
            <Link
              href="/dashboard/memberships"
              className="text-sm text-brand hover:underline"
            >
              Grant or revoke
            </Link>
          </div>

          {!memberships.data ? (
            <p className="mt-3 text-sm text-muted">
              {memberships.error ?? "Memberships could not be loaded."}
            </p>
          ) : memberships.data.items.length === 0 ? (
            <p className="mt-3 text-sm text-muted">This customer holds no memberships.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {memberships.data.items.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{m.tier.name}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {m.source === "purchase" ? "Bought" : "Granted by staff"}
                      {m.endsAt
                        ? ` · ${m.status === "expired" ? "ended" : "ends"} ${new Date(
                            m.endsAt,
                          ).toLocaleDateString()}`
                        : " · no expiry"}
                      {m.revokedAt
                        ? ` · revoked ${new Date(m.revokedAt).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <Badge variant={STATUS_VARIANT[m.status]}>{m.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-base font-medium text-foreground">Orders</h2>

          {!orders.data ? (
            <p className="mt-3 text-sm text-muted">
              {orders.error ?? "Orders could not be loaded."}
            </p>
          ) : orders.data.items.length === 0 ? (
            <EmptyState
              className="mt-3"
              title="No orders yet"
              description="This record exists because an account was created, not because anything was bought."
            />
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="text-muted">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-4 font-medium">Order</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Rail</th>
                    <th className="py-2 pr-4 font-medium">Amount</th>
                    <th className="py-2 font-medium">Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.items.map((o) => (
                    <tr key={o.id} className="border-b border-border last:border-0">
                      <td className="py-2.5 pr-4 text-foreground">#{o.id}</td>
                      <td className="py-2.5 pr-4">
                        <Badge
                          variant={
                            o.status === "success"
                              ? "success"
                              : o.status === "failed" || o.status === "cancel"
                                ? "error"
                                : "neutral"
                          }
                        >
                          {o.status}
                        </Badge>
                      </td>
                      {/* The rail is always labelled, never assumed (payment-rail neutrality). */}
                      <td className="py-2.5 pr-4 text-muted">{o.provider}</td>
                      <td className="py-2.5 pr-4 tabular-nums text-foreground">
                        {formatCents(o.amountCents, o.currency)}
                      </td>
                      <td className="py-2.5 text-muted">
                        {new Date(o.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {c.addresses.length > 0 ? (
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
            <h2 className="text-base font-medium text-foreground">Addresses</h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {c.addresses.map((a) => (
                <li
                  key={a.id}
                  className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4 text-sm"
                >
                  {a.isDefault ? <Badge variant="neutral">Default</Badge> : null}
                  <p className="mt-2 text-foreground">{a.name ?? c.email}</p>
                  <p className="text-muted">
                    {a.line1}
                    {a.line2 ? `, ${a.line2}` : ""}
                  </p>
                  <p className="text-muted">
                    {[a.city, a.province, a.postalCode].filter(Boolean).join(", ")}
                  </p>
                  <p className="text-muted">{a.country}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-sm)]">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight text-foreground">{value}</p>
    </div>
  );
}
