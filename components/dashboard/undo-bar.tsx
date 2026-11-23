"use client";

import { useState } from "react";
import { undoInvocation } from "@/lib/api/actions";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Button } from "@/components/ui/button";

/** The usual undo toast after an undoable registry action. */
export function UndoBar({
  actionId,
  invocationId,
  message,
  onUndone,
}: {
  actionId: string;
  invocationId: string;
  message: string;
  onUndone?: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (hidden) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border bg-hover-soft px-3 py-2">
      <p className="text-sm text-foreground">{message}</p>
      <div className="flex items-center gap-2">
        {error ? <p className="text-sm text-error-text">{error}</p> : null}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await undoInvocation(actionId, invocationId);
              setHidden(true);
              onUndone?.();
            } catch (err) {
              setError(publicErrorMessage(err, "Could not undo."));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Undoing…" : "Undo"}
        </Button>
      </div>
    </div>
  );
}
