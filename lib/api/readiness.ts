import { invokeAction } from "./actions";
import { apiGet, buildQuery } from "./client";
import { callWhenLive } from "./planned";

const READINESS_SECTION = "API §9";

/**
 * ✅ LIVE since 2026-08-01 — overview, issues, issue detail, export, history,
 * and the completeness matrix are all routed (`app/api/readiness/`).
 *
 * Triage is not here: it is the `readiness.updateIssues` action, because no
 * route handler mutates state outside the registry (§22 rule 1).
 */
const READINESS_API_LIVE = true;

export type ReadinessComponent = {
  key:
    | "product_data"
    | "inventory"
    | "policies"
    | "checkout"
    | "protocol_coverage";
  label: string;
  score: number;
  weight: number;
  issueCounts: {
    critical: number;
    warning: number;
    opportunity: number;
  };
};

export type ReadinessReport = {
  scope: "organization" | "site" | "product";
  scopeId: number | null;
  score: number;
  grade: "critical" | "needs_work" | "good" | "excellent";
  trend: { delta: number; since: string } | null;
  components: ReadinessComponent[];
  counts: { critical: number; warning: number; opportunity: number };
  computedAt: string;
};

export type ReadinessIssue = {
  id: string;
  severity: "critical" | "warning" | "opportunity";
  component: ReadinessComponent["key"];
  code: string;
  title: string;
  status: "open" | "resolved" | "dismissed" | "assigned";
  scope: {
    siteId: number | null;
    productId: number | null;
    categoryId: number | null;
    channelId: string | null;
  };
  affectedFields: string[];
  evidence: { field: string; current: string | null; expected: string }[];
  recommendation: string;
  expectedImpact: string;
  assignedTo: string | null;
  detectedAt: string;
  updatedAt: string;
};

export function getReadinessOverview(
  query?: { siteId?: number; productId?: number; environment?: "test" | "production" },
  init?: RequestInit,
) {
  return callWhenLive(READINESS_API_LIVE, READINESS_SECTION, () =>
    apiGet<ReadinessReport>("/api/readiness/overview", query, init),
  );
}

export function listReadinessIssues(
  query?: {
    severity?: ReadinessIssue["severity"];
    status?: ReadinessIssue["status"];
    siteId?: number;
    productId?: number;
    categoryId?: number;
    channelId?: string;
    component?: ReadinessComponent["key"];
    q?: string;
    sort?: "-severity" | "detectedAt";
    page?: number;
    limit?: number;
  },
  init?: RequestInit,
) {
  return callWhenLive(READINESS_API_LIVE, READINESS_SECTION, () =>
    apiGet<{
      items: ReadinessIssue[];
      total: number;
      page: number;
      limit: number;
      counts: { critical: number; warning: number; opportunity: number };
    }>("/api/readiness/issues", query, init),
  );
}

/**
 * Drawer payload for one issue.
 *
 * **A 404 here is not a missing row** — issues are recomputed per request, so it
 * means the issue is no longer present, which usually means it was fixed. Screens
 * should say that rather than reporting an error.
 */
export function getReadinessIssue(id: string, init?: RequestInit) {
  return callWhenLive(READINESS_API_LIVE, READINESS_SECTION, () =>
    apiGet<ReadinessIssue>(`/api/readiness/issues/${encodeURIComponent(id)}`, undefined, init),
  );
}

/** CSV, so this is a URL to link at — never fetched and re-encoded through JSON. */
export function readinessIssuesExportUrl(
  query?: Parameters<typeof listReadinessIssues>[0],
) {
  return `/api/readiness/issues/export${buildQuery(query)}`;
}

export type ReadinessHistoryPoint = {
  date: string;
  score: number;
  components: Partial<Record<ReadinessComponent["key"], number>>;
};

/**
 * **History is never backfilled** (§9). A store scored for three days returns
 * three points, not a flat line invented back to its creation date — so an empty
 * series comes back with `note` explaining why, and a chart must render that
 * rather than zeros it would draw as a crash to nothing.
 */
export function getReadinessHistory(
  query?: {
    scope?: ReadinessReport["scope"];
    scopeId?: number;
    from?: string;
    to?: string;
  },
  init?: RequestInit,
) {
  return callWhenLive(READINESS_API_LIVE, READINESS_SECTION, () =>
    apiGet<{ points: ReadinessHistoryPoint[]; note?: string }>(
      "/api/readiness/history",
      query,
      init,
    ),
  );
}

export type CompletenessGroup = {
  group: string;
  label: string;
  fields: string[];
};

export type CompletenessRow = {
  productId: number;
  name: string;
  slug: string;
  siteId: number;
  score: number;
  groups: Record<string, { complete: number; total: number; state: "complete" | "partial" | "empty" }>;
  issueCount: number;
};

/**
 * The completeness matrix (FR-CM-01).
 *
 * `columns` carries only groups with real fields behind them; anything the
 * platform offers no way to fill is reported in `notMeasured` with a reason,
 * because scoring a merchant on a field that does not exist would be a
 * fabricated criticism (§9).
 */
export function getReadinessProducts(
  query?: {
    siteId?: number;
    categoryId?: number;
    q?: string;
    page?: number;
    limit?: number;
    sort?: string;
  },
  init?: RequestInit,
) {
  return callWhenLive(READINESS_API_LIVE, READINESS_SECTION, () =>
    apiGet<{
      columns: CompletenessGroup[];
      items: CompletenessRow[];
      notMeasured: (CompletenessGroup & { reason: string })[];
      total: number;
      page: number;
      limit: number;
    }>("/api/readiness/products", query, init),
  );
}

/**
 * Bulk triage — the health table's row actions.
 *
 * **Resolving is not fixing.** It records "handled outside the rule's view" and
 * stops the issue counting; `catalogChanged` is always `false` so no surface can
 * imply the catalog was edited. Fixing the product makes the issue disappear on
 * its own, with no action needed.
 */
export function updateReadinessIssues(
  body: {
    ids: string[];
    action: "resolve" | "dismiss" | "assign" | "reopen";
    assignee?: string;
    note?: string;
  },
  init?: RequestInit,
) {
  return invokeAction<{
    updated: number;
    status: ReadinessIssue["status"];
    issueIds: string[];
    catalogChanged: false;
  }>("readiness.updateIssues", body, init);
}
