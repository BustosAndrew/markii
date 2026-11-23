"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { blockFormSender, unblockFormSender, type BlocklistEntry } from "@/lib/api/forms";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { UndoBar } from "@/components/dashboard/undo-bar";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { LocalDateTime } from "@/components/ui/local-date";

export function FormBlocklistPanel({
  siteId,
  items,
  canWrite,
}: {
  siteId: number;
  items: BlocklistEntry[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ actionId: string; invocationId: string; message: string } | null>(null);

  return (
    <div className="space-y-6">
      {undo ? <UndoBar {...undo} onUndone={() => router.refresh()} /> : null}
      {error ? <p className="text-sm text-error-text">{error}</p> : null}

      {canWrite ? (
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            if (!pattern.trim()) return;
            setBusy(true);
            try {
              const out = await blockFormSender({
                siteId,
                pattern: pattern.trim(),
                note: note.trim() || undefined,
              });
              if (out.ok && out.undoable) {
                setUndo({ actionId: "forms.blockSender", invocationId: out.invocationId, message: `Blocked ${out.result?.pattern ?? pattern}.` });
              }
              setPattern("");
              setNote("");
              router.refresh();
            } catch (err) {
              setError(publicErrorMessage(err, "Could not block that sender."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="min-w-0 flex-1">
            <Label htmlFor="block-pattern">Block an email or domain</Label>
            <Input
              id="block-pattern"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="someone@example.com or @example.com"
              required
            />
          </div>
          <div className="min-w-0 flex-1">
            <Label htmlFor="block-note">Note (optional)</Label>
            <Input id="block-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Block"}
          </Button>
        </form>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing is blocked.</p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-medium">Pattern</th>
                <th className="px-4 py-3 font-medium">Note</th>
                <th className="px-4 py-3 font-medium">Added</th>
                {canWrite ? <th className="px-4 py-3 font-medium" /> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-mono text-foreground">{row.pattern}</td>
                  <td className="px-4 py-3 text-muted">{row.note || "—"}</td>
                  <td className="px-4 py-3 text-muted">
                    <LocalDateTime value={row.createdAt} />
                  </td>
                  {canWrite ? (
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError(null);
                          try {
                            const out = await unblockFormSender({ siteId, entryId: row.id });
                            if (out.ok && out.undoable) {
                              setUndo({
                                actionId: "forms.unblockSender",
                                invocationId: out.invocationId,
                                message: `Unblocked ${row.pattern}.`,
                              });
                            }
                            router.refresh();
                          } catch (err) {
                            setError(publicErrorMessage(err, "Could not unblock."));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Unblock
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
