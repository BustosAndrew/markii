import { apiGet } from "./client";
import { callWhenLive } from "./planned";

const READINESS_SECTION = "API §9";
const READINESS_API_LIVE = false;

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
