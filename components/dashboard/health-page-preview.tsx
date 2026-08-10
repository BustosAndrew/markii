"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ComingSoon } from "@/components/ui/coming-soon";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import { sanitizePublicCopy } from "@/lib/api/public-copy";
import {
  getReadinessIssue,
  listReadinessIssues,
  readinessIssuesExportUrl,
  updateReadinessIssues,
  type ReadinessIssue,
  type ReadinessReport,
} from "@/lib/api/readiness";
import { ApiClientError } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const SEVERITY_VARIANT: Record<
  ReadinessIssue["severity"],
  "error" | "warning" | "info"
> = {
  critical: "error",
  warning: "warning",
  opportunity: "info",
};

const STATUS_VARIANT: Record<
  ReadinessIssue["status"],
  "success" | "warning" | "error" | "neutral" | "info"
> = {
  open: "warning",
  assigned: "info",
  resolved: "success",
  dismissed: "neutral",
};

export type IssuesPage = {
  items: ReadinessIssue[];
  total: number;
  page: number;
  limit: number;
  counts: { critical: number; warning: number; opportunity: number };
};

export function HealthPagePreview({
  report,
  initialIssues,
  planned = false,
  error,
}: {
  report: ReadinessReport | null;
  initialIssues?: IssuesPage | null;
  planned?: boolean;
  error?: string | null;
}) {
  const [severity, setSeverity] = useState<"" | ReadinessIssue["severity"]>("");
  const [status, setStatus] = useState<"" | ReadinessIssue["status"]>("open");
  const [issues, setIssues] = useState<IssuesPage | null>(initialIssues ?? null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function reload(
    nextSeverity: typeof severity = severity,
    nextStatus: typeof status = status,
  ) {
    setLoading(true);
    setListError(null);
    try {
      const data = await listReadinessIssues({
        severity: nextSeverity || undefined,
        status: nextStatus || undefined,
        sort: "-severity",
        limit: 50,
      });
      setIssues(data);
    } catch (caught) {
      setIssues(null);
      setListError(
        caught instanceof Error
          ? caught.message
          : "Health issues could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (planned) {
    return (
      <ComingSoon
        title="Health issues aren’t available yet"
        description="Issue detection, severity counts, and resolution actions will appear here when catalog health is ready."
      />
    );
  }

  if (error) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Health issues</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {sanitizePublicCopy(error) || "Health issues are unavailable right now."}
        </p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Health issues</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Configuration required before readiness signals can be displayed.
        </p>
      </section>
    );
  }

  const counts = issues?.counts ?? report.counts;

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-medium text-foreground">Readiness score</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Product data, inventory, policies, checkout, and protocol coverage.
            </p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-semibold tracking-tight text-foreground">
              {report.score}
            </p>
            <p className="text-sm capitalize text-muted">
              {report.grade.replace("_", " ")}
            </p>
            {report.trend ? (
              <p className="mt-1 text-xs text-muted">
                {report.trend.delta >= 0 ? "+" : ""}
                {report.trend.delta} since{" "}
                {new Date(report.trend.since).toLocaleDateString()}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <CountChip label="Critical" value={counts.critical} tone="error" />
          <CountChip label="Warning" value={counts.warning} tone="warning" />
          <CountChip label="Opportunity" value={counts.opportunity} tone="info" />
        </div>

        <div className="mt-5 space-y-3">
          {report.components.map((component) => (
            <div key={component.key}>
              <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                <span className="text-foreground">{component.label}</span>
                <span className="text-muted">{component.score}</span>
              </div>
              <div className="h-2 rounded-full bg-hover">
                <div
                  className={cn(
                    "h-2 rounded-full",
                    report.grade === "critical"
                      ? "bg-brand"
                      : report.grade === "needs_work"
                        ? "bg-warning-text"
                        : "bg-success-text",
                  )}
                  style={{ width: `${Math.max(0, Math.min(component.score, 100))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Issues</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Recomputed from the catalog on each load. Resolving records triage — it does not
              edit products.
            </p>
          </div>
          <a
            href={readinessIssuesExportUrl({
              severity: severity || undefined,
              status: status || undefined,
            })}
            className="text-sm font-medium text-brand hover:text-brand-hover"
          >
            Export CSV
          </a>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <Select
            className="sm:w-auto"
            value={severity}
            onChange={(e) => {
              const next = e.target.value as typeof severity;
              setSeverity(next);
              void reload(next, status);
            }}
            aria-label="Filter by severity"
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="opportunity">Opportunity</option>
          </Select>
          <Select
            className="sm:w-auto"
            value={status}
            onChange={(e) => {
              const next = e.target.value as typeof status;
              setStatus(next);
              void reload(severity, next);
            }}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="assigned">Assigned</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
          </Select>
        </div>

        {listError ? (
          <p className="mt-4 text-sm text-muted">
            {sanitizePublicCopy(listError) || "Issues could not be loaded."}
          </p>
        ) : loading && !issues ? (
          <p className="mt-4 text-sm text-muted">Loading issues…</p>
        ) : !issues || issues.items.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No issues match"
            description={
              status === "open"
                ? "Nothing open right now. Try another status filter, or check the score above."
                : "Nothing in this filter. Clear filters to see the full list."
            }
          />
        ) : (
          <ul className={cn("mt-4 divide-y divide-border", loading && "opacity-70")}>
            {issues.items.map((issue) => (
              <li key={issue.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-start justify-between gap-3 py-3 text-left transition-colors hover:bg-hover-soft"
                  onClick={() => setSelectedId(issue.id)}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{issue.title}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {issue.component.replace(/_/g, " ")} · {issue.code}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={SEVERITY_VARIANT[issue.severity]}>{issue.severity}</Badge>
                    <Badge variant={STATUS_VARIANT[issue.status]}>{issue.status}</Badge>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}

        {issues && issues.total > issues.items.length ? (
          <p className="mt-3 text-xs text-muted">
            Showing {issues.items.length} of {issues.total}
          </p>
        ) : null}
      </section>

      {selectedId ? (
        <IssueDrawer
          key={selectedId}
          issueId={selectedId}
          onClose={() => setSelectedId(null)}
          onTriaged={() => {
            setSelectedId(null);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CountChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "error" | "warning" | "info";
}) {
  return (
    <div className="rounded-[var(--radius-control)] border border-border bg-surface-elevated px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          tone === "error" && "text-error-text",
          tone === "warning" && "text-warning-text",
          tone === "info" && "text-info-text",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function IssueDrawer({
  issueId,
  onClose,
  onTriaged,
}: {
  issueId: string;
  onClose: () => void;
  onTriaged: () => void;
}) {
  const [detail, setDetail] = useState<
    | { kind: "loading" }
    | { kind: "ready"; issue: ReadinessIssue }
    | { kind: "gone" }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Parent remounts via key={issueId}. State updates only in the async path.
  useEffect(() => {
    let cancelled = false;
    void getReadinessIssue(issueId)
      .then((issue) => {
        if (!cancelled) setDetail({ kind: "ready", issue });
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiClientError && caught.status === 404) {
          setDetail({ kind: "gone" });
          return;
        }
        setDetail({
          kind: "error",
          message:
            caught instanceof Error
              ? caught.message
              : "Issue detail could not be loaded.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  async function triage(action: "resolve" | "dismiss" | "reopen") {
    setBusy(true);
    setActionError(null);
    try {
      await updateReadinessIssues({ ids: [issueId], action });
      onTriaged();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "Could not update this issue.",
      );
    } finally {
      setBusy(false);
    }
  }

  const issue = detail.kind === "ready" ? detail.issue : null;

  return (
    <Drawer
      open
      onClose={onClose}
      title={issue?.title ?? (detail.kind === "gone" ? "Issue no longer present" : "Issue")}
      description={
        issue
          ? `${issue.severity} · ${issue.component.replace(/_/g, " ")} · ${issue.code}`
          : detail.kind === "gone"
            ? "Issues are recomputed from the catalog — a missing issue usually means it was fixed."
            : undefined
      }
      footer={
        issue ? (
          <div className="flex flex-wrap justify-end gap-2">
            {(issue.status === "open" || issue.status === "assigned") && (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void triage("dismiss")}
                >
                  Dismiss
                </Button>
                <Button disabled={busy} onClick={() => void triage("resolve")}>
                  Mark resolved
                </Button>
              </>
            )}
            {(issue.status === "resolved" || issue.status === "dismissed") && (
              <Button disabled={busy} onClick={() => void triage("reopen")}>
                Reopen
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        )
      }
    >
      {detail.kind === "error" ? (
        <p className="text-sm text-muted">
          {sanitizePublicCopy(detail.message) || "Issue detail is unavailable."}
        </p>
      ) : detail.kind === "gone" ? (
        <p className="text-sm leading-6 text-muted">
          This issue is gone from the current catalog scan. That usually means the underlying
          product or setting was fixed — not that triage failed.
        </p>
      ) : detail.kind === "loading" || !issue ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          <p className="text-sm leading-6 text-muted">{issue.recommendation}</p>
          <p className="text-sm leading-6 text-muted">
            <span className="font-medium text-foreground">Expected impact: </span>
            {issue.expectedImpact}
          </p>

          {issue.affectedFields.length > 0 ? (
            <section>
              <h3 className="text-sm font-medium text-foreground">Affected fields</h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {issue.affectedFields.map((field) => (
                  <li key={field}>
                    <Badge variant="neutral">{field}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {issue.evidence.length > 0 ? (
            <section>
              <h3 className="text-sm font-medium text-foreground">Evidence</h3>
              <ul className="mt-2 space-y-2">
                {issue.evidence.map((row) => (
                  <li
                    key={`${row.field}-${row.expected}`}
                    className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-3 text-sm"
                  >
                    <p className="font-medium text-foreground">{row.field}</p>
                    <p className="mt-1 text-muted">Current: {row.current ?? "—"}</p>
                    <p className="text-muted">Expected: {row.expected}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="text-xs text-muted">
            Detected {new Date(issue.detectedAt).toLocaleString()}
            {issue.assignedTo ? ` · Assigned to ${issue.assignedTo}` : ""}
          </p>

          {actionError ? (
            <p className="text-sm text-error-text" role="alert">
              {sanitizePublicCopy(actionError)}
            </p>
          ) : null}

          <p className="text-xs text-muted">
            Marking resolved does not change the catalog. Fix the product so the issue disappears
            on the next scan, or record that you handled it outside the rule.
          </p>
        </div>
      )}
    </Drawer>
  );
}
