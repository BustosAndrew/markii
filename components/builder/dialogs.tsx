"use client";

import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import {
  getDesignChecks,
  getDesignDiff,
  listDesignVersions,
  type CheckResult,
  type DesignDiff,
  type DesignVersion,
} from "@/lib/api/builder";
import { ApiClientError } from "@/lib/api/types";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label } from "@/components/ui/field";
import { LocalDateTime } from "@/components/ui/local-date";
import { DesignDiffView, type DiffTierName } from "./design-diff";

export function Modal({
  open,
  title,
  onClose,
  children,
  size = "md",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: "md" | "lg";
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-[85vh] w-full overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-md)] ${size === "lg" ? "max-w-2xl" : "max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          <button type="button" className="rounded p-1 hover:bg-hover" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CheckList({ items, tone }: { items: CheckResult[]; tone: "error" | "warning" }) {
  if (items.length === 0) return null;
  return (
    <ul className={`space-y-1 rounded-[var(--radius-control)] p-3 text-sm ${tone === "error" ? "bg-error-bg text-error-text" : "bg-warning-bg text-warning-text"}`}>
      {items.map((c, i) => (
        <li key={`${c.code}-${c.nodeId ?? i}`}>
          {c.message}
          {c.pageHandle ? <span className="opacity-75"> — {c.pageHandle === "home" ? "home page" : `/pages/${c.pageHandle}`}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Publish runs the same checks the server will: **errors block, warnings
 * inform** (`docs/BUILDER.md` §12). The button stays disabled while an error
 * stands, and the server refuses anyway if the draft changed underneath.
 */
type PublishProps = {
  open: boolean;
  site: number;
  onClose: () => void;
  onPublish: (note: string) => Promise<boolean>;
  onDiscard: () => Promise<boolean>;
  hasUnpublishedChanges: boolean;
  onSelectNode?: (documentId: number, nodeId: string) => void;
  tiers?: DiffTierName[];
};

/** Mounted only while open, so every opening starts from fresh checks. */
export function PublishDialog(props: PublishProps) {
  return props.open ? <OpenPublishDialog {...props} /> : null;
}

function OpenPublishDialog({ open, site, onClose, onPublish, onDiscard, hasUnpublishedChanges, onSelectNode, tiers }: PublishProps) {
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [diff, setDiff] = useState<DesignDiff | "none" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    getDesignChecks(site)
      .then((r) => setChecks(r.results))
      .catch((e) => setLoadError(publicErrorMessage(e, "Could not run the pre-publish checks.")));
    getDesignDiff(site)
      .then(setDiff)
      .catch((e) => {
        const reason =
          e instanceof ApiClientError && e.details && typeof e.details === "object"
            ? (e.details as { reason?: string }).reason
            : null;
        if (reason === "nothing_published") setDiff("none");
        else setLoadError(publicErrorMessage(e, "Could not compare with the live design."));
      });
  }, [site]);

  const errors = checks?.filter((c) => c.severity === "error") ?? [];
  const warnings = checks?.filter((c) => c.severity === "warning") ?? [];

  return (
    <Modal open={open} title="Publish your design" onClose={onClose} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Publishing makes every page, the theme and its colours live on your storefront at once. You can restore an earlier version from History.
        </p>
        {diff && diff !== "none" ? (
          <div>
            <h3 className="mb-2 text-sm font-medium text-foreground">What publishing will change</h3>
            <DesignDiffView
              diff={diff}
              tiers={tiers}
              onSelectNode={
                onSelectNode
                  ? (documentId, nodeId) => {
                      onSelectNode(documentId, nodeId);
                      onClose();
                    }
                  : undefined
              }
            />
          </div>
        ) : null}
        {loadError ? <p className="text-sm text-error-text">{loadError}</p> : null}
        {checks === null && !loadError ? <p className="text-sm text-muted">Checking the draft…</p> : null}
        <CheckList items={errors} tone="error" />
        <CheckList items={warnings} tone="warning" />
        {checks && errors.length === 0 && warnings.length === 0 ? <p className="text-sm text-success-text">No problems found.</p> : null}
        <div>
          <Label htmlFor="pub-note">Note (optional)</Label>
          <Input id="pub-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Autumn refresh" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" disabled={busy || !hasUnpublishedChanges} onClick={() => setConfirmDiscard(true)}>
            Discard changes
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || checks === null || errors.length > 0}
              onClick={async () => {
                setBusy(true);
                const ok = await onPublish(note.trim());
                setBusy(false);
                if (ok) {
                  setNote("");
                  onClose();
                }
              }}
            >
              {busy ? "Publishing…" : "Publish"}
            </Button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unpublished changes?"
        description="Every page, the theme and its colours go back to what is live now. Pages that were never published are removed. This cannot be undone."
        confirmLabel="Discard"
        danger
        busy={busy}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={async () => {
          setBusy(true);
          const ok = await onDiscard();
          setBusy(false);
          setConfirmDiscard(false);
          if (ok) onClose();
        }}
      />
    </Modal>
  );
}

type HistoryProps = {
  open: boolean;
  site: number;
  onClose: () => void;
  onRestore: (version: number) => Promise<boolean>;
  onSelectNode?: (documentId: number, nodeId: string) => void;
  tiers?: DiffTierName[];
};

/** Mounted only while open, so the list is fetched fresh each time. */
export function HistoryDialog(props: HistoryProps) {
  return props.open ? <OpenHistoryDialog {...props} /> : null;
}

function OpenHistoryDialog({ open, site, onClose, onRestore, onSelectNode, tiers }: HistoryProps) {
  const [items, setItems] = useState<DesignVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<{ version: number; diff: DesignDiff } | "loading" | null>(null);

  useEffect(() => {
    listDesignVersions(site)
      .then((r) => setItems(r.items))
      .catch((e) => setError(publicErrorMessage(e, "Could not load the version history.")));
  }, [site]);

  return (
    <Modal open={open} title="Published versions" onClose={onClose} size="lg">
      {error ? <p className="text-sm text-error-text">{error}</p> : null}
      {items === null && !error ? <p className="text-sm text-muted">Loading…</p> : null}
      {items?.length === 0 ? <p className="text-sm text-muted">Nothing has been published yet.</p> : null}
      {compare && compare !== "loading" ? (
        <div className="mb-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">Version {compare.version} compared with current draft</h3>
            <Button variant="ghost" onClick={() => setCompare(null)}>
              Back to list
            </Button>
          </div>
          <DesignDiffView
            diff={compare.diff}
            tiers={tiers}
            identicalMessage={`The current draft matches version ${compare.version}.`}
            onSelectNode={
              onSelectNode
                ? (documentId, nodeId) => {
                    onSelectNode(documentId, nodeId);
                    onClose();
                  }
                : undefined
            }
          />
        </div>
      ) : (
      <ul className="divide-y divide-border">
        {items?.map((v) => (
          <li key={v.version} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Version {v.version}
                {v.note ? <span className="font-normal text-muted"> — {v.note}</span> : null}
              </p>
              <p className="text-xs text-muted">
                <LocalDateTime value={v.createdAt} />
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                disabled={compare === "loading"}
                onClick={async () => {
                  setCompare("loading");
                  setError(null);
                  try {
                    const d = await getDesignDiff(site, { from: v.version });
                    setCompare({ version: v.version, diff: d });
                  } catch (e) {
                    setCompare(null);
                    setError(publicErrorMessage(e, "Could not compare that version."));
                  }
                }}
              >
                Compare with current draft
              </Button>
              <Button variant="secondary" onClick={() => setPending(v.version)}>
                Restore to draft
              </Button>
            </div>
          </li>
        ))}
      </ul>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={`Restore version ${pending}?`}
        description="It replaces your current draft. Nothing goes live until you publish. Your current unpublished changes cannot be recovered."
        confirmLabel="Restore"
        danger
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending === null) return;
          setBusy(true);
          const ok = await onRestore(pending);
          setBusy(false);
          setPending(null);
          if (ok) onClose();
        }}
      />
    </Modal>
  );
}
