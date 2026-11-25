"use client";

import { useState } from "react";
import { exportStore, previewStoreExport, type StoreExport } from "@/lib/api/store-export";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LocalDateTime } from "@/components/ui/local-date";

function count(preview: StoreExport, key: string) {
  return preview.counts[key] ?? 0;
}

export function StoreExportPanel({ siteId }: { siteId: number }) {
  const [preview, setPreview] = useState<StoreExport | null>(null);
  const [result, setResult] = useState<StoreExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function loadPreview() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await previewStoreExport(siteId);
      if (!out.ok || !out.result) {
        setError("Could not preview the export.");
        return;
      }
      setPreview(out.result);
      setConfirm(true);
    } catch (err) {
      setError(publicErrorMessage(err, "Could not preview the export."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <div>
        <h2 className="text-base font-medium text-foreground">Move this store</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Everything in this store, in one file, to move it to your own Markii. It holds your customers&apos;
          personal data — keep it like a database backup and delete it once it is imported.
        </p>
      </div>
      {error ? <p className="text-sm text-error-text">{error}</p> : null}
      <Button disabled={busy} onClick={() => void loadPreview()}>
        {busy ? "Preparing…" : "Export store"}
      </Button>
      {result ? (
        <div className="space-y-2 text-sm leading-6 text-muted">
          <p className="font-medium text-foreground">Your export is ready.</p>
          <p>
            The zip link lasts five minutes. Links to sold files inside it expire at{" "}
            <LocalDateTime value={result.files.linksExpireAt} /> — import before then, or export again.
          </p>
          {result.headCodeLeftOut ? (
            <p>Your custom scripts are not included; add them again on the new store.</p>
          ) : null}
          <ButtonLinkSafe href={result.url} />
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title="Export this store?"
        description={
          preview
            ? `This file will contain ${count(preview, "customers").toLocaleString()} customers' names, emails and addresses, ${count(preview, "orders").toLocaleString()} orders, and ${count(preview, "products").toLocaleString()} products.`
            : "This file holds every customer's personal data."
        }
        confirmLabel="Create export"
        busy={busy}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            const out = await exportStore(siteId);
            if (!out.ok || !out.result) {
              setError("The export could not be created.");
              return;
            }
            // Offered as a link, not opened: after an await a browser may block the popup silently.
            setResult(out.result);
            setConfirm(false);
          } catch (err) {
            setError(publicErrorMessage(err, "The export could not be created."));
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}

function ButtonLinkSafe({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-center rounded-[var(--radius-control)] bg-brand px-4 py-2.5 text-sm font-medium text-on-brand hover:bg-brand-hover"
    >
      Download zip
    </a>
  );
}
