"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createStorefrontKey,
  revokeStorefrontKey,
  type StorefrontKey,
} from "@/lib/api/storefront-keys";
import { ApiClientError } from "@/lib/api/types";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label } from "@/components/ui/field";

/**
 * Per-store secret keys for an exported storefront's server (D53).
 *
 * The plaintext exists once, at create. Treat it like a password: copy here,
 * never a toast, never the URL. Revoke is immediate and not undoable.
 */
export function StorefrontKeysPanel({
  siteId,
  keys,
  canManage,
  loadError,
}: {
  siteId: number;
  keys: StorefrontKey[] | null;
  canManage: boolean;
  loadError?: string | null;
}) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ key: string; prefix: string; label: string } | null>(null);
  const [revoking, setRevoking] = useState<StorefrontKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : publicErrorMessage(err, "That did not work."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <div>
        <h2 className="text-base font-medium text-foreground">Exported storefront</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Put this in your exported store&rsquo;s server environment. Anyone who has it can act as
          any of this store&rsquo;s customers. Never put it in browser code.
        </p>
      </div>

      {!canManage ? (
        <p className="text-sm leading-6 text-muted">
          Only an owner, administrator or developer can create or revoke storefront keys.
        </p>
      ) : loadError ? (
        <p className="text-sm leading-6 text-muted">
          Storefront keys could not be loaded, so nothing here is shown rather than shown wrong.{" "}
          {loadError}
        </p>
      ) : (
        <>
          {keys && keys.length === 0 && !minted ? (
            <p className="text-sm text-muted">No storefront keys yet.</p>
          ) : null}

          {keys && keys.length > 0 ? (
            <ul className="divide-y divide-border">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{k.label}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      <span className="font-mono">{k.prefix}…</span>
                      {k.lastUsedAt
                        ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                        : " · never used"}
                    </p>
                  </div>
                  {k.revokedAt ? (
                    <Badge variant="neutral">Revoked</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => setRevoking(k)}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          <form
            className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              const value = label.trim();
              if (!value) return;
              void run("create", async () => {
                const out = await createStorefrontKey({ siteId, label: value });
                const key = out.result?.key;
                if (!key) {
                  setError("The key was created but could not be shown. Revoke it and create another.");
                  return;
                }
                setMinted({ key, prefix: out.result?.prefix ?? "", label: value });
                setCopied(false);
                setLabel("");
              });
            }}
          >
            <div>
              <Label htmlFor="storefront-key-label">New key</Label>
              <Input
                id="storefront-key-label"
                value={label}
                placeholder="Exported Next.js app"
                disabled={busy !== null}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-1.5 w-56"
              />
            </div>
            <Button type="submit" disabled={busy !== null || label.trim() === ""}>
              {busy === "create" ? "Creating…" : "Create key"}
            </Button>
          </form>

          {minted ? (
            <div className="rounded-[var(--radius-control)] border border-brand/30 bg-warning-bg p-4">
              <p className="text-sm font-medium text-warning-text">
                Copy this now — it is not shown again.
              </p>
              <p className="mt-2 break-all rounded bg-surface p-2 font-mono text-xs text-foreground">
                {minted.key}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(minted.key).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button variant="ghost" onClick={() => setMinted(null)}>
                  Done
                </Button>
              </div>
            </div>
          ) : null}

          {error ? <FieldError>{error}</FieldError> : null}

          <ConfirmDialog
            open={revoking !== null}
            danger
            busy={busy?.startsWith("revoke-") ?? false}
            title={`Revoke ${revoking?.label ?? ""}?`}
            description="The exported storefront that uses this key stops being able to act as your customers immediately. Revoking cannot be undone — create a new key instead."
            confirmLabel="Revoke key"
            onClose={() => setRevoking(null)}
            onConfirm={() => {
              const target = revoking;
              setRevoking(null);
              if (target) {
                void run(`revoke-${target.id}`, () =>
                  revokeStorefrontKey({ siteId, keyId: target.id }),
                );
              }
            }}
          />
        </>
      )}
    </section>
  );
}
