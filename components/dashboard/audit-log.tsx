"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { undoInvocation } from "@/lib/api/actions";
import {
  type AuditActorType,
  type AuditRiskTier,
  type OrgAuditEntry,
} from "@/lib/api/org";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const ACTOR_LABEL: Record<AuditActorType, string> = {
  user: "Person",
  agent: "Agent",
  token: "Token",
  system: "System",
};

const RISK_LABEL: Record<AuditRiskTier, string> = {
  read: "Read",
  low: "Low",
  medium: "Medium",
  high: "High",
};

type UndoConflict = {
  entity: string;
  path: string;
  expected: unknown;
  current: unknown;
};

function actorLabel(entry: OrgAuditEntry): string {
  if (entry.actor.name) return entry.actor.name;
  if (entry.actor.id) return entry.actor.id;
  return ACTOR_LABEL[entry.actor.type];
}

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

function undoKind(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || error.status !== 409) return null;
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const undo = (details as { undo?: unknown }).undo;
  return typeof undo === "string" ? undo : null;
}

function undoConflicts(error: unknown): UndoConflict[] {
  if (!(error instanceof ApiClientError)) return [];
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const conflicts = (details as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts.filter((row): row is UndoConflict => {
    return (
      !!row &&
      typeof row === "object" &&
      typeof (row as UndoConflict).path === "string"
    );
  });
}

export function AuditLog({ items }: { items: OrgAuditEntry[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [target, setTarget] = useState<OrgAuditEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<UndoConflict[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [hiddenUndo, setHiddenUndo] = useState<Set<string>>(new Set());

  async function runUndo() {
    if (!target) return;
    setBusyId(target.id);
    setError(null);
    setConflicts([]);
    setMessage(null);
    try {
      const outcome = await undoInvocation(target.action, target.id);
      setMessage(`${outcome.undoneWith} reversed the change.`);
      setTarget(null);
      router.refresh();
    } catch (err) {
      const kind = undoKind(err);
      if (kind === "conflict") {
        setConflicts(undoConflicts(err));
        setError(
          publicErrorMessage(
            err,
            "This has changed since. Undoing would overwrite the later edit.",
          ),
        );
        return;
      }
      if (
        kind === "already_undone" ||
        kind === "no_inverse" ||
        kind === "not_representable" ||
        kind === "failed_invocation"
      ) {
        setHiddenUndo((prev) => new Set(prev).add(target.id));
        setTarget(null);
      }
      setError(publicErrorMessage(err, "Could not undo that change."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {error ? <p className="mb-3 text-sm text-error-text">{error}</p> : null}
      {conflicts.length > 0 ? (
        <ul className="mb-3 space-y-1 rounded-[var(--radius-control)] bg-warning-bg px-4 py-3 text-sm text-warning-text">
          {conflicts.map((row) => (
            <li key={`${row.entity}:${row.path}`}>
              <span className="font-medium">{row.path}</span>
              {" would go from "}
              <span className="tabular-nums">{formatValue(row.current)}</span>
              {" back to "}
              <span className="tabular-nums">{formatValue(row.expected)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p className="mb-3 text-sm text-success-text">{message}</p> : null}

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="px-4 py-3 font-normal">When</th>
              <th className="px-4 py-3 font-normal">Who</th>
              <th className="px-4 py-3 font-normal">Action</th>
              <th className="px-4 py-3 font-normal">Outcome</th>
              <th className="px-4 py-3 font-normal">Touched</th>
              <th className="px-4 py-3 font-normal">From</th>
              <th className="px-4 py-3 font-normal" />
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => {
              const reversed = Boolean(entry.undoneBy);
              const reversal = Boolean(entry.undoOf);
              const showUndo =
                entry.ok &&
                entry.undoable &&
                !reversed &&
                !reversal &&
                !hiddenUndo.has(entry.id);

              return (
                <tr
                  key={entry.id}
                  className={`border-t border-border align-top ${
                    reversed ? "text-muted" : ""
                  }`}
                >
                  <td className="px-4 py-3 whitespace-nowrap text-muted">
                    <time dateTime={entry.occurredAt}>
                      {new Date(entry.occurredAt).toLocaleString()}
                    </time>
                  </td>
                  <td className="px-4 py-3">
                    <p className={reversed ? "line-through" : "text-foreground"}>
                      {actorLabel(entry)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {ACTOR_LABEL[entry.actor.type]}
                      {entry.actor.email ? ` · ${entry.actor.email}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className={`font-mono text-xs ${reversed ? "line-through" : "text-foreground"}`}>
                      {entry.action}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {RISK_LABEL[entry.riskTier]}
                      {reversal ? " · reversal" : ""}
                      {reversed ? " · reversed" : ""}
                    </p>
                    {entry.changes.length > 0 ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
                          {entry.changes.length === 1
                            ? "1 field"
                            : `${entry.changes.length} fields`}
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs text-muted">
                          {entry.changes.map((change) => (
                            <li key={`${change.entity}:${change.entityId}:${change.path}`}>
                              <span className="text-foreground">{change.path}</span>
                              {": "}
                              {formatValue(change.before)}
                              {" → "}
                              {formatValue(change.after)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {entry.ok ? (
                      <Badge variant="success">Applied</Badge>
                    ) : (
                      <div>
                        <Badge variant="neutral">Refused</Badge>
                        {entry.error?.message ? (
                          <p className="mt-1.5 max-w-xs text-xs leading-5 text-muted">
                            {entry.error.code ? `${entry.error.code} · ` : ""}
                            {entry.error.message}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {entry.entities.length === 0
                      ? "—"
                      : entry.entities
                          .map((entity) => `${entity.type} ${entity.id}`)
                          .join(", ")}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    {entry.ip ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {showUndo ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busyId !== null}
                        onClick={() => {
                          setError(null);
                          setConflicts([]);
                          setTarget(entry);
                        }}
                      >
                        Undo
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={target !== null}
        title="Undo this change?"
        description={
          target
            ? `This runs ${target.action} in reverse as a new action. It is recorded, and it can ask for a second factor.`
            : ""
        }
        confirmLabel="Undo"
        danger
        busy={busyId !== null}
        onClose={() => busyId === null && setTarget(null)}
        onConfirm={() => void runUndo()}
      />
    </div>
  );
}
