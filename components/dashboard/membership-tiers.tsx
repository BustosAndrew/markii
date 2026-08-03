"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { listCustomers, type Customer } from "@/lib/api/commerce";
import {
  createMembershipTier,
  deleteMembershipTier,
  grantMembership,
  revokeMembership,
  type MembershipTier,
} from "@/lib/api/memberships";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError, Input, Label, Select } from "@/components/ui/field";

type SiteOption = { id: number; name: string };

export function MembershipTiers({
  tiers,
  sites,
  selectedSiteId,
}: {
  tiers: MembershipTier[];
  sites: SiteOption[];
  selectedSiteId: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MembershipTier | null>(null);

  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState<number | null>(selectedSiteId ?? sites[0]?.id ?? null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Tiers</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          A product can require a tier (only members may buy it) and a product can grant one
          (buying it confers membership). Counts are current as of this page load — a membership
          lapses by its own expiry date.
        </p>

        {tiers.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No membership tiers yet"
            description="Create a tier, then set a product to require it or to grant it."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4 font-medium">Tier</th>
                  <th className="py-2 pr-4 font-medium">Active members</th>
                  <th className="py-2 pr-4 font-medium">Ever held</th>
                  <th className="py-2 pr-4 font-medium">Gated products</th>
                  <th className="py-2 pr-4 font-medium">Sold by</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-foreground">{t.name}</div>
                      <div className="text-xs text-muted">{t.handle}</div>
                    </td>
                    <td className="py-3 pr-4 tabular-nums text-foreground">
                      {t.activeMemberCount}
                    </td>
                    <td className="py-3 pr-4 tabular-nums text-muted">{t.totalMemberCount}</td>
                    <td className="py-3 pr-4 tabular-nums text-foreground">
                      {t.gatedProductCount}
                    </td>
                    <td className="py-3 pr-4">
                      {/*
                        A tier nothing sells can only be granted by hand. Worth
                        showing, because it usually means a product is missing
                        its "grants" setting rather than that it was intended.
                      */}
                      {t.grantingProductCount > 0 ? (
                        <span className="tabular-nums text-foreground">
                          {t.grantingProductCount} product
                          {t.grantingProductCount === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <Badge variant="neutral">Manual only</Badge>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <Button
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => setRemoving(t)}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form
          className="mt-5 flex flex-wrap items-end gap-2 border-t border-border pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            const value = name.trim();
            if (!value || siteId === null) return;
            void run("create", async () => {
              await createMembershipTier({ siteId, name: value });
              setName("");
            });
          }}
        >
          <div>
            <Label htmlFor="tier-name">New tier</Label>
            <Input
              id="tier-name"
              value={name}
              placeholder="Gold"
              disabled={busy !== null}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 w-56"
            />
          </div>
          <div>
            <Label htmlFor="tier-site">Store</Label>
            <Select
              id="tier-site"
              className="mt-1.5 w-56"
              value={siteId ?? ""}
              disabled={busy !== null}
              onChange={(e) => setSiteId(Number(e.target.value))}
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={busy !== null || !name.trim() || siteId === null}>
            {busy === "create" ? "Creating…" : "Create tier"}
          </Button>
        </form>

        {error ? <FieldError>{error}</FieldError> : null}
      </section>

      {tiers.length > 0 ? <GrantPanel tiers={tiers} onDone={() => router.refresh()} /> : null}

      <ConfirmDialog
        open={removing !== null}
        danger
        busy={busy?.startsWith("delete-") ?? false}
        title={`Delete ${removing?.name ?? ""}?`}
        /*
          The consequence people do not expect: `requires_tier_id` is
          `on delete set null`, so deleting a tier makes every product behind it
          public. Nothing errors, and paid-for content is simply open.
        */
        description={
          removing
            ? `This removes ${removing.activeMemberCount} active membership${
                removing.activeMemberCount === 1 ? "" : "s"
              }` +
              (removing.gatedProductCount > 0
                ? `, and ${removing.gatedProductCount} product${
                    removing.gatedProductCount === 1 ? "" : "s"
                  } behind this tier will become visible to everyone. Nothing will error — the content simply stops being members-only.`
                : ". No products are gated by it.")
            : ""
        }
        confirmLabel="Delete tier"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) {
            void run(`delete-${target.id}`, () => deleteMembershipTier({ tierId: target.id }));
          }
        }}
      />
    </div>
  );
}

/**
 * Grant or revoke by hand — comping a member, fixing a guest checkout that could
 * not receive the membership it paid for, or ending one early.
 */
function GrantPanel({ tiers, onDone }: { tiers: MembershipTier[]; onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[] | null>(null);
  const [tierId, setTierId] = useState<number>(tiers[0]?.id ?? 0);
  const [days, setDays] = useState("365");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">Grant or revoke</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        Find a customer, then give them a tier or end it. Extending starts from their current
        expiry, so renewing early never costs them unused time. Leave the duration empty for a
        membership that does not expire.
      </p>

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            "search",
            async () => {
              const res = await listCustomers({ q: query.trim() || undefined, limit: 10 });
              setResults(res.items);
            },
            "",
          );
        }}
      >
        <div>
          <Label htmlFor="cust-q">Customer email</Label>
          <Input
            id="cust-q"
            value={query}
            placeholder="buyer@example.com"
            disabled={busy !== null}
            onChange={(e) => setQuery(e.target.value)}
            className="mt-1.5 w-64"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={busy !== null}>
          {busy === "search" ? "Searching…" : "Search"}
        </Button>
      </form>

      {results !== null ? (
        results.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            No customer matched. A shopper only has a record once they have ordered or created an
            account at this store.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="grant-tier">Tier</Label>
                <Select
                  id="grant-tier"
                  className="mt-1.5 w-48"
                  value={tierId}
                  disabled={busy !== null}
                  onChange={(e) => setTierId(Number(e.target.value))}
                >
                  {tiers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="grant-days">Days (blank = no expiry)</Label>
                <Input
                  id="grant-days"
                  value={days}
                  inputMode="numeric"
                  disabled={busy !== null}
                  onChange={(e) => setDays(e.target.value)}
                  className="mt-1.5 w-40"
                />
              </div>
            </div>

            <ul className="divide-y divide-border">
              {results.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{c.email}</p>
                    <p className="text-xs text-muted">
                      {c.ordersCount} order{c.ordersCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy !== null || !tierId}
                      onClick={() =>
                        void act(
                          `grant-${c.id}`,
                          () =>
                            grantMembership({
                              customerId: c.id,
                              tierId,
                              durationDays: days.trim() === "" ? null : Number(days),
                            }),
                          `Granted to ${c.email}.`,
                        )
                      }
                    >
                      {busy === `grant-${c.id}` ? "Granting…" : "Grant"}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy !== null || !tierId}
                      onClick={() =>
                        void act(
                          `revoke-${c.id}`,
                          () => revokeMembership({ customerId: c.id, tierId }),
                          `Revoked for ${c.email}.`,
                        )
                      }
                    >
                      {busy === `revoke-${c.id}` ? "Revoking…" : "Revoke"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      {notice ? <p className="mt-3 text-sm text-success-text">{notice}</p> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </section>
  );
}
