import {
  COMPONENTS,
  SEVERITY_PENALTY,
  gradeFor,
  type AgentReadinessReport,
  type ComponentKey,
  type ComponentReport,
  type ReadinessIssue,
  type Severity,
} from "./types";

/**
 * Turning findings into a score (§9) — pure, so the arithmetic is testable
 * without a catalog.
 *
 * The model is **per subject, then averaged**: every product and every store
 * starts at 100 and loses points for its own open issues, and a component's
 * score is the mean across the subjects it covers.
 *
 * That shape is not incidental. The obvious alternative — one running penalty
 * per component — floors at zero and then stops moving, so a merchant with
 * fifty products missing descriptions sees exactly the same score after fixing
 * forty-five of them. The people with the most work to do would get the least
 * feedback. Averaging per subject means every fix moves the number, while a
 * catalog where nothing is filled in still scores near zero.
 *
 * It stays explainable either way: a merchant can be told which product cost
 * which points, which is the whole reason `docs/BACKEND.md` §5 requires rules
 * rather than a model.
 */

/** Issues that no longer count against the score. */
function isOpen(issue: Pick<ReadinessIssue, "status">): boolean {
  return issue.status === "open" || issue.status === "assigned";
}

/** Which product or store an issue is about. Store issues carry no productId. */
export function subjectKey(scope: { siteId: number | null; productId: number | null }): string {
  return scope.productId != null ? `p:${scope.productId}` : `s:${scope.siteId ?? "org"}`;
}

/** Every subject a report covers, so healthy ones count toward the average too. */
export type Subjects = { products: string[]; stores: string[] };

export function subjectsFor(component: ComponentKey, subjects: Subjects): string[] {
  const spec = COMPONENTS.find((c) => c.key === component);
  if (!spec) return [];
  if (spec.subjects === "products") return subjects.products;
  if (spec.subjects === "stores") return subjects.stores;
  return [...subjects.products, ...subjects.stores];
}

/**
 * One subject's score for one component: 100 less its own open issues, floored.
 *
 * The floor is right *here* — a single product with ten problems is simply as
 * bad as a product gets, and a negative would distort the mean it feeds.
 */
export function subjectScore(issues: Pick<ReadinessIssue, "severity" | "status">[]): number {
  const penalty = issues.filter(isOpen).reduce((sum, i) => sum + SEVERITY_PENALTY[i.severity], 0);
  return Math.max(0, 100 - penalty);
}

/**
 * A component's score: the mean of its subjects' scores.
 *
 * With no subjects at all — an org with no stores yet — there is nothing to
 * judge, and 100 would be a claim rather than a measurement. It returns 100 so
 * an empty account does not open on a wall of red, and the issue list carries
 * the real message ("you have no products").
 */
export function componentScore(
  issues: Pick<ReadinessIssue, "severity" | "status" | "scope">[],
  subjectKeys: string[],
): number {
  if (subjectKeys.length === 0) return 100;

  const bySubject = new Map<string, Pick<ReadinessIssue, "severity" | "status">[]>();
  for (const key of subjectKeys) bySubject.set(key, []);
  for (const issue of issues) {
    const key = subjectKey(issue.scope);
    // An issue about a subject outside this component's universe is ignored
    // rather than silently creating a sixth subject nobody counted.
    bySubject.get(key)?.push(issue);
  }

  const total = [...bySubject.values()].reduce((sum, list) => sum + subjectScore(list), 0);
  return total / bySubject.size;
}

export function countBySeverity(
  issues: Pick<ReadinessIssue, "severity" | "status">[],
): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, warning: 0, opportunity: 0 };
  for (const issue of issues) if (isOpen(issue)) counts[issue.severity] += 1;
  return counts;
}

/**
 * The full report.
 *
 * Components are always all five, in the order §9 pins, even when a component
 * has no issues — a card that disappears when it is healthy is a card a
 * merchant cannot learn to read.
 */
export function buildReport(input: {
  scope: AgentReadinessReport["scope"];
  scopeId: number | null;
  issues: Pick<ReadinessIssue, "severity" | "status" | "component" | "scope">[];
  subjects: Subjects;
  previous?: { score: number; at: string } | null;
  computedAt?: Date;
}): AgentReadinessReport {
  const components: ComponentReport[] = COMPONENTS.map((c) => {
    const mine = input.issues.filter((i) => i.component === c.key);
    return {
      key: c.key,
      label: c.label,
      // Rounded for display only; the weighted mean below uses the exact value.
      score: Math.round(componentScore(mine, subjectsFor(c.key, input.subjects))),
      weight: c.weight,
      issueCounts: countBySeverity(mine),
    };
  });

  /**
   * The headline is computed from the **unrounded** component scores and
   * rounded once, at the end. Rounding each part first lets five small
   * roundings move the number a merchant is watching.
   */
  const weighted = COMPONENTS.reduce((sum, c) => {
    const mine = input.issues.filter((i) => i.component === c.key);
    return sum + componentScore(mine, subjectsFor(c.key, input.subjects)) * c.weight;
  }, 0);
  const score = Math.round(weighted);

  return {
    scope: input.scope,
    scopeId: input.scopeId,
    score,
    grade: gradeFor(score),
    trend: input.previous ? { delta: score - input.previous.score, since: input.previous.at } : null,
    components,
    counts: countBySeverity(input.issues),
    computedAt: (input.computedAt ?? new Date()).toISOString(),
  };
}

/** Sort order for the issues list: worst first, then most recent. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  opportunity: 2,
};

export function compareIssues(a: ReadinessIssue, b: ReadinessIssue): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  // Stable tiebreak on id, so two runs of the same catalog list identically.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const COMPONENT_KEYS: ComponentKey[] = COMPONENTS.map((c) => c.key);
