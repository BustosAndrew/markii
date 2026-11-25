"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { blockFormSender, deleteFormSubmission, type FormSubmissionItem } from "@/lib/api/forms";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { UndoBar } from "@/components/dashboard/undo-bar";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LocalDateTime } from "@/components/ui/local-date";

function notifyLabel(notify: FormSubmissionItem["notify"]) {
  if (notify.status === "sent") return "Emailed";
  if (notify.status === "failed") return `Email failed${notify.error ? `: ${notify.error}` : ""}`;
  if (notify.status === "off") return "Not emailed";
  return "Email pending";
}

function answer(value: string | boolean) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value;
}

export function FormSubmissionsList({
  items,
  canWrite,
  siteId,
}: {
  items: FormSubmissionItem[];
  canWrite: boolean;
  siteId: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [erasing, setErasing] = useState<FormSubmissionItem | null>(null);
  const [undo, setUndo] = useState<{ actionId: string; invocationId: string; message: string } | null>(null);

  async function block(pattern: string) {
    setError(null);
    setBusy(-1);
    try {
      const out = await blockFormSender({ siteId, pattern });
      if (out.ok && out.undoable) {
        setUndo({ actionId: "forms.blockSender", invocationId: out.invocationId, message: `Blocked ${pattern}.` });
      }
      router.refresh();
    } catch (err) {
      setError(publicErrorMessage(err, "Could not block that sender."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {undo ? <UndoBar {...undo} onUndone={() => router.refresh()} /> : null}
      {error ? <p className="text-sm text-error-text">{error}</p> : null}
      <ul className="space-y-4">
        {items.map((item) => {
          const domain = item.email?.includes("@") ? `@${item.email.split("@")[1]}` : null;
          return (
            <li key={item.id} className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {item.form.name}
                    {!item.form.exists ? <span className="ml-2 text-muted">(deleted form)</span> : null}
                  </p>
                  <p className="text-xs text-muted">
                    {item.form.handle} · <LocalDateTime value={item.createdAt} />
                  </p>
                </div>
                <Badge variant={item.notify.status === "failed" ? "error" : item.notify.status === "sent" ? "success" : "neutral"}>
                  {notifyLabel(item.notify)}
                </Badge>
              </div>
              <dl className="mt-4 space-y-1 text-sm">
                {item.values.map((v) => (
                  <div key={v.name} className="grid grid-cols-[8rem_1fr] gap-3">
                    <dt className="text-muted">{v.label}</dt>
                    <dd className="text-foreground">{answer(v.value)}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                {item.email ? (
                  <ButtonLink variant="secondary" href={`mailto:${encodeURIComponent(item.email)}`}>
                    Reply
                  </ButtonLink>
                ) : null}
                {canWrite && item.email ? (
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void block(item.email!)}>
                    Block {item.email}
                  </Button>
                ) : null}
                {canWrite && domain ? (
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void block(domain)}>
                    Block {domain}
                  </Button>
                ) : null}
                {canWrite ? (
                  <Button variant="ghost" disabled={busy !== null} onClick={() => setErasing(item)}>
                    Delete
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={erasing !== null}
        title="Delete this submission?"
        description="This is for an erasure request. It cannot be undone. Submissions are otherwise kept permanently."
        confirmLabel="Delete"
        danger
        busy={busy !== null}
        onClose={() => setErasing(null)}
        onConfirm={async () => {
          if (!erasing) return;
          setBusy(erasing.id);
          setError(null);
          try {
            await deleteFormSubmission({ submissionId: erasing.id });
            setErasing(null);
            router.refresh();
          } catch (err) {
            setError(publicErrorMessage(err, "The submission could not be deleted."));
            setErasing(null);
          } finally {
            setBusy(null);
          }
        }}
      />
    </div>
  );
}
