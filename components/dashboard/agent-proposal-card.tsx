"use client";

import { useState } from "react";
import Link from "next/link";
import { undoInvocation } from "@/lib/api/actions";
import {
  approveAgentProposal,
  rejectAgentProposal,
  type AgentProposal,
} from "@/lib/api/agents";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isStaleRefusal(error: unknown): boolean {
  if (!(error instanceof ApiClientError) || error.status !== 409) return false;
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  return (details as { status?: unknown }).status === "stale";
}

function undoKind(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || error.status !== 409) return null;
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const undo = (details as { undo?: unknown }).undo;
  return typeof undo === "string" ? undo : null;
}

const STATUS_BADGE: Record<
  AgentProposal["status"],
  { label: string; variant: "success" | "warning" | "error" | "info" | "neutral" }
> = {
  pending: { label: "Needs approval", variant: "info" },
  approving: { label: "Applying…", variant: "info" },
  executed: { label: "Applied", variant: "success" },
  rejected: { label: "Rejected", variant: "neutral" },
  failed: { label: "Failed", variant: "error" },
  stale: { label: "Store changed", variant: "warning" },
};

export function AgentProposalCard({
  proposal,
  onChange,
}: {
  proposal: AgentProposal;
  onChange: (next: AgentProposal) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | "undo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);

  const status = STATUS_BADGE[proposal.status];
  const pending = proposal.status === "pending" || proposal.status === "approving";
  const deciding = proposal.status === "approving" || busy !== null;

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      const result = await approveAgentProposal(proposal.id);
      onChange(result.proposal);
    } catch (err) {
      if (isStaleRefusal(err)) {
        onChange({ ...proposal, status: "stale", error: publicErrorMessage(err) });
        return;
      }
      setError(publicErrorMessage(err, "Could not apply that change."));
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setError(null);
    try {
      const result = await rejectAgentProposal(proposal.id);
      onChange(result.proposal);
    } catch (err) {
      setError(publicErrorMessage(err, "Could not reject that proposal."));
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    if (!proposal.invocationId) return;
    setBusy("undo");
    setError(null);
    try {
      await undoInvocation(proposal.actionId, proposal.invocationId);
      setUndone(true);
      setConfirmUndo(false);
    } catch (err) {
      const kind = undoKind(err);
      if (kind === "already_undone") {
        setUndone(true);
        setConfirmUndo(false);
        return;
      }
      setError(publicErrorMessage(err, "Could not undo that change."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-sm)]">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{proposal.summary}</p>
          <p className="mt-0.5 font-mono text-xs text-muted">{proposal.actionId}</p>
        </div>
        <Badge variant={undone ? "neutral" : status.variant}>
          {undone ? "Undone" : status.label}
        </Badge>
      </header>

      {proposal.rationale ? (
        <p className="mt-3 text-sm leading-6 text-muted">
          <span className="font-medium text-foreground">Agent: </span>
          {proposal.rationale}
        </p>
      ) : null}

      {proposal.diff.length > 0 ? (
        <ul className="mt-3 space-y-1.5 rounded-[var(--radius-control)] border border-border bg-surface-elevated px-3 py-2.5 text-sm">
          {proposal.diff.map((entry) => (
            <li key={`${entry.entity}:${entry.entityId}:${entry.path}`}>
              <span className="text-foreground">{entry.path}</span>
              <span className="text-muted">
                {" "}
                {formatValue(entry.before)} → {formatValue(entry.after)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">No field changes in this proposal.</p>
      )}

      <p className="mt-2 text-xs text-muted">
        {proposal.affectedCount === 1
          ? "1 item affected"
          : `${proposal.affectedCount} items affected`}
      </p>

      {proposal.status === "stale" ? (
        <p className="mt-3 text-sm leading-6 text-warning-text">
          The store changed after this was proposed, so nothing was applied. Ask the agent
          to propose it again — do not retry this card.
        </p>
      ) : null}

      {proposal.status === "failed" && proposal.error ? (
        <p className="mt-3 text-sm leading-6 text-error-text">{proposal.error}</p>
      ) : null}

      {error ? <p className="mt-3 text-sm text-error-text">{error}</p> : null}

      {pending ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            className="px-3 py-1.5 text-sm"
            disabled={deciding}
            onClick={() => void approve()}
          >
            {busy === "approve" ? "Applying…" : "Approve"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-3 py-1.5 text-sm"
            disabled={deciding}
            onClick={() => void reject()}
          >
            Reject
          </Button>
        </div>
      ) : null}

      {proposal.status === "executed" && proposal.invocationId && !undone ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            className="px-3 py-1.5 text-sm"
            disabled={busy === "undo"}
            onClick={() => setConfirmUndo(true)}
          >
            Undo
          </Button>
          <Link
            href={`/dashboard/settings/audit?actionId=${encodeURIComponent(proposal.actionId)}`}
            className="text-sm text-muted underline-offset-2 hover:text-foreground hover:underline"
          >
            View in audit log
          </Link>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmUndo}
        title="Undo this change?"
        description="This runs the inverse of what was applied. It is a new action, not a rollback of the original."
        confirmLabel="Undo"
        danger
        busy={busy === "undo"}
        onConfirm={() => void undo()}
        onClose={() => {
          if (busy !== "undo") setConfirmUndo(false);
        }}
      />
    </article>
  );
}
