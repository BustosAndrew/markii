/**
 * Agent readiness (§9) — the contract types.
 *
 * **Rule-based and deterministic. No model inference, ever.**
 * `docs/PRICING.md` §"Margin check" makes that a cost constraint rather than a
 * preference: per-product inference on every plan would exceed every other
 * infrastructure line combined. It is also what lets a merchant be *told why*
 * their score moved, which a model score cannot do honestly.
 */

export type Severity = "critical" | "warning" | "opportunity";

/** Always these five, in this order — §9 pins both. */
export type ComponentKey =
  | "product_data"
  | "inventory"
  | "policies"
  | "checkout"
  | "protocol_coverage";

export type IssueStatus = "open" | "resolved" | "dismissed" | "assigned";

export type IssueScope = {
  siteId: number | null;
  productId: number | null;
  categoryId: number | null;
  channelId: string | null;
};

export type ReadinessIssue = {
  id: string;
  severity: Severity;
  component: ComponentKey;
  /** Stable machine code — `MISSING_DESCRIPTION`, `NO_SHIPPING_RATE`. */
  code: string;
  title: string;
  status: IssueStatus;
  scope: IssueScope;
  affectedFields: string[];
  evidence: { field: string; current: string | null; expected: string }[];
  recommendation: string;
  /** Plain language, and never a promise about ranking or revenue. */
  expectedImpact: string;
  assignedTo: string | null;
  detectedAt: string;
  updatedAt: string;
};

export type ComponentReport = {
  key: ComponentKey;
  label: string;
  score: number;
  weight: number;
  issueCounts: { critical: number; warning: number; opportunity: number };
};

export type AgentReadinessReport = {
  scope: "organization" | "site" | "product";
  scopeId: number | null;
  score: number;
  grade: "critical" | "needs_work" | "good" | "excellent";
  trend: { delta: number; since: string } | null;
  components: ComponentReport[];
  counts: { critical: number; warning: number; opportunity: number };
  computedAt: string;
};

/**
 * What a component is scored *over*.
 *
 * This is what makes the score move for a large catalog. `product_data` is
 * scored per product and averaged, so fixing one product out of fifty always
 * shifts the number; `checkout` is a property of the store and is scored once.
 * Scoring checkout across products would let fifty healthy products drown out a
 * store that cannot take payment at all.
 */
export type SubjectScope = "products" | "stores" | "both";

/**
 * Component weights. They sum to 1, and the split says what agent readiness
 * actually depends on: an agent cannot buy what it cannot understand
 * (`product_data`), and it cannot buy at all if checkout is unconfigured.
 */
export const COMPONENTS: {
  key: ComponentKey;
  label: string;
  weight: number;
  subjects: SubjectScope;
}[] = [
  { key: "product_data", label: "Product data", weight: 0.3, subjects: "both" },
  { key: "inventory", label: "Inventory", weight: 0.15, subjects: "both" },
  { key: "policies", label: "Policies", weight: 0.15, subjects: "stores" },
  { key: "checkout", label: "Checkout", weight: 0.25, subjects: "stores" },
  { key: "protocol_coverage", label: "Protocol coverage", weight: 0.15, subjects: "stores" },
];

/**
 * What each severity costs its component, in points.
 *
 * A critical is worth roughly four warnings because the two are not the same
 * kind of problem: a critical means an agent **cannot** complete something —
 * no price, no payment rail, no shipping rate — while a warning means it can,
 * less well. An opportunity is an improvement nobody is currently failing.
 */
export const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 20,
  warning: 5,
  opportunity: 1,
};

export function gradeFor(score: number): AgentReadinessReport["grade"] {
  if (score < 50) return "critical";
  if (score < 75) return "needs_work";
  if (score < 90) return "good";
  return "excellent";
}
