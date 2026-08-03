"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createToken,
  deleteToken,
  type CreatedToken,
  type ScopedToken,
  type StaffRole,
} from "@/lib/api/org";
import { ApiClientError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Select } from "@/components/ui/field";

/** `owner` is refused by the API — a token that can do everything, forever, is the one worth stealing. */
const TOKEN_ROLES: StaffRole[] = [
  "administrator",
  "catalog_manager",
  "commerce_manager",
  "analyst",
  "developer",
  "viewer",
];

export function TokensPanel({
  tokens,
  sites,
}: {
  tokens: ScopedToken[];
  sites: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ScopedToken | null>(null);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<StaffRole>("viewer");
  /** `"all"`, or a single store id. Narrower is safer, so it is offered up front. */
  const [scope, setScope] = useState<string>("all");
  const [minted, setMinted] = useState<CreatedToken | null>(null);

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
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">API tokens</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        Scoped, role-bound credentials for agents, MCP clients, and CI — never a copy of someone&rsquo;s
        session. A token can never do more than the role it carries.
      </p>

      {tokens.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No tokens.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t.label}</p>
                <p className="mt-0.5 text-xs text-muted">
                  <span className="font-mono">{t.prefix}…</span> · {t.role} ·{" "}
                  {t.storeIds === "all" ? "all stores" : `${t.storeIds.length} store(s)`} ·{" "}
                  {/*
                    "Never used" is worth showing plainly: an unused token is
                    usually one that was minted and forgotten, which is exactly
                    the credential to revoke.
                  */}
                  {t.lastUsedAt
                    ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                    : "never used"}
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => setRemoving(t)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-5 flex flex-wrap items-end gap-2 border-t border-border pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          const value = label.trim();
          if (!value) return;
          void run("create", async () => {
            const created = await createToken({
              label: value,
              role,
              storeIds: scope === "all" ? "all" : [Number(scope)],
            });
            setLabel("");
            // Shown once, and only here — the server keeps a hash, so this is
            // the only moment the plaintext exists anywhere it can be copied.
            setMinted(created);
          });
        }}
      >
        <div>
          <Label htmlFor="token-label">New token</Label>
          <Input
            id="token-label"
            value={label}
            placeholder="CI deploy"
            disabled={busy !== null}
            onChange={(e) => setLabel(e.target.value)}
            className="mt-1.5 w-56"
          />
        </div>
        <div>
          <Label htmlFor="token-role">Role</Label>
          <Select
            id="token-role"
            className="mt-1.5 w-48"
            value={role}
            disabled={busy !== null}
            onChange={(e) => setRole(e.target.value as StaffRole)}
          >
            {TOKEN_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </div>
        {sites.length > 1 ? (
          <div>
            <Label htmlFor="token-scope">Scope</Label>
            <Select
              id="token-scope"
              className="mt-1.5 w-48"
              value={scope}
              disabled={busy !== null}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="all">All stores</option>
              {sites.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <Button type="submit" disabled={busy !== null || !label.trim()}>
          {busy === "create" ? "Creating…" : "Create token"}
        </Button>
      </form>

      {minted ? (
        <div className="mt-4 rounded-[var(--radius-control)] border border-brand/30 bg-warning-bg p-4">
          <p className="text-sm font-medium text-warning-text">
            Copy this now — it is not shown again.
          </p>
          <p className="mt-2 break-all rounded bg-surface p-2 font-mono text-xs text-foreground">
            {minted.token}
          </p>
          {minted.tokenNote ? (
            <p className="mt-2 text-xs text-warning-text">{minted.tokenNote}</p>
          ) : null}
          <Button variant="secondary" className="mt-3" onClick={() => setMinted(null)}>
            Done
          </Button>
        </div>
      ) : null}

      {error ? <FieldError>{error}</FieldError> : null}

      <ConfirmDialog
        open={removing !== null}
        danger
        busy={busy?.startsWith("revoke-") ?? false}
        title={`Revoke ${removing?.label ?? ""}?`}
        description="Anything using this token stops working immediately — scripts, agents, and CI included. Revoking cannot be undone; mint a new one instead."
        confirmLabel="Revoke token"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) void run(`revoke-${target.id}`, () => deleteToken(target.id));
        }}
      />
    </section>
  );
}
