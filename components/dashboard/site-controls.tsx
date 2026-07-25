"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteSite, deploySite, updateSite } from "@/lib/api/sites";
import { ApiClientError, type Site } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

export function SiteControls({ site }: { site: Site }) {
  const router = useRouter();
  const [current, setCurrent] = useState(site);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState(site.customDomain ?? "");
  const [pauseOpen, setPauseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function patch(body: Parameters<typeof updateSite>[1]) {
    setBusy(true);
    setError(null);
    try {
      const next = await updateSite(current.slug, body);
      setCurrent(next);
      if (next.slug !== current.slug) {
        router.replace(`/dashboard/websites/${next.slug}`);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface px-5">
        <Toggle
          label="Agent discovery"
          description="Serve llms.txt and agent.md for crawlers."
          checked={current.agentDiscovery}
          disabled={busy}
          onChange={(agentDiscovery) => patch({ agentDiscovery })}
        />
        <div className="border-t border-border">
          <Toggle
            label="Purchases"
            description="Allow x402 checkout on this storefront."
            checked={current.purchasesEnabled}
            disabled={busy}
            onChange={(purchasesEnabled) => patch({ purchasesEnabled })}
          />
        </div>
        <div className="border-t border-border">
          <Toggle
            label="Indexed"
            description="Include this site in sitemaps and allow indexing."
            checked={current.indexed}
            disabled={busy}
            onChange={(indexed) => patch({ indexed })}
          />
        </div>
        <div className="border-t border-border">
          <Toggle
            label="x402 payments"
            description="Accept USDC payments via x402."
            checked={current.paymentProviders.x402}
            disabled={busy}
            onChange={(x402) =>
              patch({
                paymentProviders: { ...current.paymentProviders, x402 },
              })
            }
          />
        </div>
        <div className="border-t border-border">
          <Toggle
            label="Stripe (optional)"
            description="Enable fiat checkout when Stripe is connected."
            checked={current.paymentProviders.stripe}
            disabled={busy}
            onChange={(stripe) =>
              patch({
                paymentProviders: { ...current.paymentProviders, stripe },
              })
            }
          />
        </div>
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
        <Label htmlFor="custom-domain">Custom domain</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="custom-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="shop.example.com"
          />
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              patch({ customDomain: domain.trim() ? domain.trim() : null })
            }
          >
            Save domain
          </Button>
        </div>
      </section>

      <section className="flex flex-wrap gap-2">
        {current.status !== "live" ? (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await deploySite(current.slug);
                router.refresh();
              } catch (err) {
                setError(
                  err instanceof ApiClientError ? err.message : "Deploy failed.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Deploy live
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setPauseOpen(true)}
          >
            Pause website
          </Button>
        )}
        {current.status === "paused" ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => patch({ status: "live" })}
          >
            Resume
          </Button>
        ) : null}
        <Button
          variant="ghost"
          className="text-error-text"
          disabled={busy}
          onClick={() => setDeleteOpen(true)}
        >
          Delete
        </Button>
      </section>

      <FieldError>{error}</FieldError>

      <ConfirmDialog
        open={pauseOpen}
        title="Pause this website?"
        description="Agents will no longer be able to discover or purchase until you resume."
        confirmLabel="Pause"
        busy={busy}
        onClose={() => setPauseOpen(false)}
        onConfirm={async () => {
          setPauseOpen(false);
          await patch({ status: "paused" });
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete this website?"
        description="Categories, products, and traffic for this site will be deleted. Order history is kept."
        confirmLabel="Delete"
        danger
        busy={busy}
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await deleteSite(current.slug);
            router.push("/dashboard/websites");
            router.refresh();
          } catch (err) {
            setError(
              err instanceof ApiClientError ? err.message : "Delete failed.",
            );
            setBusy(false);
            setDeleteOpen(false);
          }
        }}
      />
    </div>
  );
}
