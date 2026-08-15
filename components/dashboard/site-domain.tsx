"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  connectDomain,
  disconnectDomain,
  verifyDomain,
  type DomainRecord,
  type SiteDomain,
} from "@/lib/api/domains";
import { ApiClientError, type Site } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label } from "@/components/ui/field";

/**
 * Custom domain settings for one storefront.
 *
 * The one thing this screen must never do is imply the domain is serving traffic
 * when it is not. Three states are shown separately because they fail
 * separately: **claimed** (typed, nothing routes), **verified** (ownership
 * proved, Markii will route it), and **pointing** (the merchant's DNS actually
 * sends traffic here). Only the last two together mean the storefront answers.
 */
export function SiteDomainCard({
  site,
  state,
  loadError,
}: {
  site: Site;
  /** Fetched on the server, like every other panel here — see `lib/api/server.ts`. */
  state: SiteDomain | null;
  /** Non-null when the status could not be read. Never rendered as "no domain". */
  loadError?: string | null;
}) {
  const router = useRouter();
  const [input, setInput] = useState(state?.domain ?? site.customDomain ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // The server re-reads DNS on refresh, so the panel reflects a fresh lookup
      // rather than the optimistic outcome of the call just made.
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
        <Label htmlFor="custom-domain">Custom domain</Label>
        <p className="mt-1.5 text-sm text-muted">
          Domain status could not be loaded, so nothing here is shown rather than shown wrong.{" "}
          {loadError}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <div>
        <Label htmlFor="custom-domain">Custom domain</Label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <Input
            id="custom-domain"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="shop.example.com"
            disabled={busy || state?.status === "verified"}
          />
          {state?.status === "verified" ? (
            <Button
              variant="ghost"
              className="shrink-0 whitespace-nowrap text-error-text"
              disabled={busy}
              onClick={() => setRemoveOpen(true)}
            >
              Remove
            </Button>
          ) : (
            <Button
              variant="secondary"
              className="shrink-0 whitespace-nowrap"
              disabled={busy || !input.trim()}
              onClick={() => run(() => connectDomain({ siteId: site.id, domain: input.trim() }))}
            >
              {state?.domain ? "Change domain" : "Connect domain"}
            </Button>
          )}
        </div>
      </div>

      {state && state.status === "none" ? (
        <p className="text-sm text-muted">
          This storefront is served at{" "}
          <span className="text-foreground">{site.storefrontUrl}</span>. Connect a domain you own to
          serve it from your own address.
        </p>
      ) : null}

      {state && state.status !== "none" ? (
        <>
          <DomainState state={state} />
          <RecordTable records={state.records} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => run(() => verifyDomain({ siteId: site.id }))}
            >
              {busy ? "Checking…" : "Check DNS"}
            </Button>
            {state.status !== "verified" ? (
              <Button
                variant="ghost"
                className="text-error-text"
                disabled={busy}
                onClick={() => setRemoveOpen(true)}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      <FieldError>{error}</FieldError>

      <ConfirmDialog
        open={removeOpen}
        title="Remove this domain?"
        description={
          state?.status === "verified"
            ? "Traffic to this domain will stop reaching your storefront immediately. Existing links, search results, and agent citations pointing at it will break. The store stays reachable on its Markii address."
            : "This claim has not verified, so nothing is currently serving on it."
        }
        confirmLabel="Remove"
        danger
        busy={busy}
        onClose={() => setRemoveOpen(false)}
        onConfirm={async () => {
          setRemoveOpen(false);
          await run(() => disconnectDomain({ siteId: site.id }));
        }}
      />
    </section>
  );
}

/**
 * Ownership and pointing are reported as two lines, never merged into one tick.
 * A merchant who published the TXT record but not the CNAME has done half the
 * job, and a single "not working" would not tell them which half.
 */
function DomainState({ state }: { state: SiteDomain }) {
  const verified = state.status === "verified";
  return (
    <div className="space-y-1.5 text-sm">
      <p>
        <span className={verified ? "text-foreground" : "text-muted"}>
          {verified ? "✓" : "○"} Ownership
        </span>{" "}
        <span className="text-muted">
          {verified
            ? `verified${state.verifiedAt ? ` on ${new Date(state.verifiedAt).toLocaleDateString()}` : ""}`
            : "not verified yet — publish the TXT record below, then check again"}
        </span>
      </p>
      <p>
        <span className={state.pointsToMarkii ? "text-foreground" : "text-muted"}>
          {state.pointsToMarkii ? "✓" : "○"} DNS pointing
        </span>{" "}
        <span className="text-muted">
          {state.pointsToMarkii
            ? "this domain resolves to Markii’s edge"
            : `not pointing here yet — traffic will not arrive until it does`}
        </span>
      </p>
      {state.problem ? <p className="text-muted">{state.problem}</p> : null}
      {state.lookupProblem ? (
        <p className="text-muted">
          DNS could not be read just now, so this may be out of date. {state.lookupProblem}
        </p>
      ) : null}
    </div>
  );
}

function RecordTable({ records }: { records: DomainRecord[] }) {
  if (records.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-control)] border border-border">
      <table className="w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th className="px-3 py-2 font-normal">Type</th>
            <th className="px-3 py-2 font-normal">Name</th>
            <th className="px-3 py-2 font-normal">Value</th>
            <th className="px-3 py-2 font-normal">Purpose</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.type}:${r.name}:${r.value}`} className="border-t border-border">
              <td className="px-3 py-2">{r.type}</td>
              <td className="break-all px-3 py-2 font-mono text-xs">{r.name}</td>
              <td className="break-all px-3 py-2 font-mono text-xs">{r.value}</td>
              <td className="px-3 py-2 text-muted">
                {r.purpose === "ownership" ? "Proves you own it" : "Sends traffic here"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
