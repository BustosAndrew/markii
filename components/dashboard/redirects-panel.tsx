"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createRedirect,
  deleteRedirect,
  importRedirects,
  previewRedirectImport,
  updateRedirect,
  type Redirect,
  type RedirectImportResult,
} from "@/lib/api/redirects";
import { ApiClientError } from "@/lib/api/types";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { UndoBar } from "@/components/dashboard/undo-bar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";
import { LocalDateTime } from "@/components/ui/local-date";

function parseCsv(text: string): { from: string; to: string; permanent?: boolean }[] {
  const lines = text.trim().split(/\r?\n/);
  const out: { from: string; to: string; permanent?: boolean }[] = [];
  for (let i = 0; i < lines.length && out.length < 1000; i++) {
    const cols = lines[i].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (i === 0 && /^(from|old)/i.test(cols[0] ?? "")) continue;
    if (cols.length < 2 || !cols[0] || !cols[1]) continue;
    const third = cols[2]?.toLowerCase();
    const row: { from: string; to: string; permanent?: boolean } = { from: cols[0], to: cols[1] };
    if (third) row.permanent = !/^(0|false|no|temp|temporary|307)$/.test(third);
    out.push(row);
  }
  return out;
}

function detailsOf(err: unknown): Record<string, unknown> | null {
  if (err instanceof ApiClientError && err.details && typeof err.details === "object" && !Array.isArray(err.details)) {
    return err.details as Record<string, unknown>;
  }
  return null;
}

export function RedirectsPanel({
  siteId,
  items,
  canWrite,
}: {
  siteId: number;
  items: Redirect[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [permanent, setPermanent] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<{ from?: string; to?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Redirect | null>(null);
  const [editTo, setEditTo] = useState("");
  const [editPermanent, setEditPermanent] = useState(true);
  const [removing, setRemoving] = useState<Redirect | null>(null);
  const [csv, setCsv] = useState("");
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<RedirectImportResult | null>(null);
  const [undo, setUndo] = useState<{ actionId: string; invocationId: string; message: string } | null>(null);

  return (
    <div className="space-y-8">
      {undo ? <UndoBar {...undo} onUndone={() => router.refresh()} /> : null}
      {error ? <p className="text-sm text-error-text">{error}</p> : null}

      {editing ? (
        <form
          className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const out = await updateRedirect({ siteId, redirectId: editing.id, to: editTo, permanent: editPermanent });
              if (out.ok && out.undoable) {
                setUndo({ actionId: "redirects.update", invocationId: out.invocationId, message: "Redirect updated." });
              }
              setEditing(null);
              router.refresh();
            } catch (err) {
              setError(publicErrorMessage(err, "Could not update."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm font-medium text-foreground">
            Edit <span className="font-mono">{editing.from}</span>
          </p>
          <div>
            <Label htmlFor="edit-to">Goes to</Label>
            <Input id="edit-to" value={editTo} onChange={(e) => setEditTo(e.target.value)} required />
          </div>
          <Toggle
            checked={editPermanent}
            label="Permanent"
            description={editPermanent ? "308 — search engines replace the old link." : "Temporary — search engines keep the old link."}
            onChange={setEditPermanent}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : canWrite ? (
        <form
          className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setFieldErrors({});
            setBusy(true);
            try {
              const out = await createRedirect({ siteId, from, to, permanent });
              if (out.ok && out.undoable) {
                setUndo({ actionId: "redirects.create", invocationId: out.invocationId, message: `Redirect from ${out.result?.from ?? from} saved.` });
              }
              setFrom("");
              setTo("");
              setPermanent(true);
              router.refresh();
            } catch (err) {
              const d = detailsOf(err);
              const field = typeof d?.field === "string" ? d.field : null;
              if (field === "from" || field === "to") {
                setFieldErrors({ [field]: err instanceof ApiClientError ? err.message : "Invalid." });
              } else if (d?.reason === "from_taken") {
                setError("There's already a redirect from that link. Edit it in the list.");
              } else {
                setError(publicErrorMessage(err, "The redirect could not be saved."));
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="redir-from">Old link</Label>
              <Input id="redir-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="https://old.example/about or /about" required />
              <FieldError>{fieldErrors.from}</FieldError>
            </div>
            <div>
              <Label htmlFor="redir-to">Goes to</Label>
              <Input id="redir-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="/pages/about or https://…" required />
              <FieldError>{fieldErrors.to}</FieldError>
            </div>
          </div>
          <Toggle
            checked={permanent}
            label="Permanent"
            description={permanent ? "308 — search engines replace the old link." : "Temporary — search engines keep the old link."}
            onChange={setPermanent}
          />
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add redirect"}
          </Button>
        </form>
      ) : null}

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-3 font-medium">From</th>
              <th className="px-4 py-3 font-medium">To</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Added</th>
              {canWrite ? <th className="px-4 py-3 font-medium" /> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 font-mono text-foreground">{row.from}</td>
                <td className="px-4 py-3 font-mono text-muted">{row.to}</td>
                <td className="px-4 py-3 text-muted">{row.permanent ? "Permanent" : "Temporary"}</td>
                <td className="px-4 py-3 text-muted">
                  <LocalDateTime value={row.createdAt} />
                </td>
                {canWrite ? (
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditing(row);
                        setEditTo(row.to);
                        setEditPermanent(row.permanent);
                      }}
                    >
                      Edit
                    </Button>{" "}
                    <Button variant="ghost" onClick={() => setRemoving(row)}>
                      Delete
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canWrite ? (
        <section className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <div>
            <h2 className="text-base font-medium text-foreground">Import from CSV</h2>
            <p className="mt-1 text-sm text-muted">Two columns: old link, new address. At most 1,000 rows. Preview first — import cannot be undone.</p>
          </div>
          <TextCsv value={csv} onChange={setCsv} />
          <Toggle checked={replace} label="Replace existing" description="Overwrite a redirect that already uses the same old link." onChange={setReplace} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy || !csv.trim()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const redirects = parseCsv(csv);
                  const out = await previewRedirectImport({ siteId, redirects, replace });
                  if (!out.ok || !out.result) {
                    setError("Preview failed.");
                    return;
                  }
                  setPreview(out.result);
                } catch (err) {
                  setError(publicErrorMessage(err, "Preview failed."));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Preview
            </Button>
            <Button
              disabled={busy || !preview}
              onClick={async () => {
                if (!preview) return;
                setBusy(true);
                setError(null);
                try {
                  const redirects = parseCsv(csv);
                  const out = await importRedirects({ siteId, redirects, replace });
                  setPreview(out.result ?? preview);
                  setCsv("");
                  router.refresh();
                } catch (err) {
                  setError(publicErrorMessage(err, "Import failed."));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Import
            </Button>
          </div>
          {preview ? (
            <div className="space-y-2 text-sm">
              <p className="text-foreground">
                {preview.created} created, {preview.replaced} replaced, {preview.skipped.length} skipped, of {preview.total}.
              </p>
              {preview.skipped.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-muted">
                  {preview.skipped.map((s) => (
                    <li key={`${s.row}-${s.from}`}>
                      Row {s.row + 1} ({s.from}): {s.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Delete this redirect?"
        description="Undo recreates it under a new id."
        confirmLabel="Delete"
        danger
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(true);
          try {
            const out = await deleteRedirect({ siteId, redirectId: removing.id });
            if (out.ok && out.undoable) {
              setUndo({ actionId: "redirects.delete", invocationId: out.invocationId, message: "Redirect deleted." });
            }
            setRemoving(null);
            router.refresh();
          } catch (err) {
            setError(publicErrorMessage(err, "Could not delete."));
            setRemoving(null);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function TextCsv({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="csv">CSV</Label>
      <textarea
        id="csv"
        rows={6}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"/old-page,/new-page\nhttps://old.example/p,/p/new"}
        className="w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2.5 font-mono text-sm text-foreground outline-none placeholder:text-muted-soft focus:border-brand focus:ring-4 focus:ring-brand/10"
      />
      <label className="inline-flex cursor-pointer text-sm font-medium text-foreground hover:text-brand">
        Upload a file
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          className="sr-only"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            onChange(await file.text());
          }}
        />
      </label>
    </div>
  );
}
