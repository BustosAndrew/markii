import { describe, expect, it } from "vitest";
import {
  buildReport,
  compareIssues,
  componentScore,
  countBySeverity,
  subjectKey,
  subjectScore,
} from "./score";
import { COMPONENTS, SEVERITY_PENALTY, gradeFor, type ReadinessIssue } from "./types";

/**
 * Readiness scoring (§9) — pure arithmetic, no catalog.
 *
 * Two properties matter more than any exact number. **Explainability**: a
 * merchant must be able to point at an issue and see the points it costs, which
 * is why these assert exact values rather than ranges. And **monotonicity**:
 * fixing something must always move the score, including for the merchants with
 * the most to fix — the failure the earlier flat-penalty model had, where a
 * catalog of fifty broken products scored zero and stayed there.
 */

const issue = (over: Partial<ReadinessIssue> = {}): ReadinessIssue => ({
  id: "iss_test",
  severity: "warning",
  component: "product_data",
  code: "TEST",
  title: "Test issue",
  status: "open",
  scope: { siteId: 1, productId: 1, categoryId: null, channelId: null },
  affectedFields: [],
  evidence: [],
  recommendation: "Fix it",
  expectedImpact: "Better",
  assignedTo: null,
  detectedAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

/** An issue about product N. */
const forProduct = (n: number, over: Partial<ReadinessIssue> = {}) =>
  issue({ scope: { siteId: 1, productId: n, categoryId: null, channelId: null }, ...over });

/** An issue about the store itself. */
const forStore = (over: Partial<ReadinessIssue> = {}) =>
  issue({ scope: { siteId: 1, productId: null, categoryId: null, channelId: null }, ...over });

const productSubjects = (n: number) => ({
  products: Array.from({ length: n }, (_, i) => `p:${i + 1}`),
  stores: ["s:1"],
});

describe("component weights", () => {
  it("sum to exactly 1", () => {
    // A drifting sum would silently rescale every merchant's headline number.
    const total = COMPONENTS.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  it("has exactly the five keys §9 pins, in order", () => {
    expect(COMPONENTS.map((c) => c.key)).toEqual([
      "product_data",
      "inventory",
      "policies",
      "checkout",
      "protocol_coverage",
    ]);
  });

  it("scores checkout over stores, not products", () => {
    // Fifty healthy products must not drown out a store that cannot take money.
    expect(COMPONENTS.find((c) => c.key === "checkout")?.subjects).toBe("stores");
    expect(COMPONENTS.find((c) => c.key === "product_data")?.subjects).toBe("both");
  });
});

describe("subjectKey", () => {
  it("separates a product from its store", () => {
    expect(subjectKey({ siteId: 1, productId: 9 })).toBe("p:9");
    expect(subjectKey({ siteId: 1, productId: null })).toBe("s:1");
  });
});

describe("subjectScore", () => {
  it("is 100 with no issues", () => {
    expect(subjectScore([])).toBe(100);
  });

  it("subtracts the severity penalty per open issue", () => {
    expect(subjectScore([issue({ severity: "critical" })])).toBe(100 - SEVERITY_PENALTY.critical);
    expect(subjectScore([issue({ severity: "warning" })])).toBe(100 - SEVERITY_PENALTY.warning);
    expect(subjectScore([issue({ severity: "opportunity" })])).toBe(
      100 - SEVERITY_PENALTY.opportunity,
    );
  });

  it("weights a critical far above a warning", () => {
    // The two differ in kind: a critical means an agent *cannot* complete
    // something, not that it does so less well.
    expect(SEVERITY_PENALTY.critical).toBeGreaterThanOrEqual(SEVERITY_PENALTY.warning * 4);
  });

  it("floors a single subject at zero", () => {
    const many = Array.from({ length: 50 }, () => issue({ severity: "critical" }));
    expect(subjectScore(many)).toBe(0);
  });

  it("ignores resolved and dismissed issues", () => {
    expect(
      subjectScore([
        issue({ severity: "critical", status: "resolved" }),
        issue({ severity: "critical", status: "dismissed" }),
      ]),
    ).toBe(100);
  });

  it("still counts an assigned issue — assigning is not fixing", () => {
    expect(subjectScore([issue({ severity: "critical", status: "assigned" })])).toBe(
      100 - SEVERITY_PENALTY.critical,
    );
  });
});

describe("componentScore", () => {
  it("averages across subjects, so healthy products dilute a broken one", () => {
    // One of four products has a critical: 3×100 + 1×80 over 4 = 95.
    const subjects = ["p:1", "p:2", "p:3", "p:4"];
    expect(componentScore([forProduct(1, { severity: "critical" })], subjects)).toBe(95);
  });

  it("keeps moving as a large broken catalog gets fixed", () => {
    // The regression that motivated this model: under a flat per-component
    // penalty all three of these scored 0, so a merchant fixing 45 of 50
    // products saw no change at all.
    const subjects = Array.from({ length: 50 }, (_, i) => `p:${i + 1}`);
    const broken = (n: number) =>
      Array.from({ length: n }, (_, i) => forProduct(i + 1, { severity: "critical" }));

    const all = componentScore(broken(50), subjects);
    const most = componentScore(broken(45), subjects);
    const some = componentScore(broken(5), subjects);

    expect(all).toBeLessThan(most);
    expect(most).toBeLessThan(some);
    expect(some).toBeLessThan(100);
  });

  it("still scores a wholly unfilled catalog near zero", () => {
    // Averaging must not become forgiving: every product broken is still bad.
    const subjects = Array.from({ length: 20 }, (_, i) => `p:${i + 1}`);
    const issues = subjects.flatMap((_, i) => [
      forProduct(i + 1, { severity: "critical" }),
      forProduct(i + 1, { severity: "critical" }),
      forProduct(i + 1, { severity: "critical" }),
      forProduct(i + 1, { severity: "critical" }),
      forProduct(i + 1, { severity: "critical" }),
    ]);
    expect(componentScore(issues, subjects)).toBe(0);
  });

  it("returns 100 when there is nothing to judge", () => {
    // An org with no stores yet should not open on a wall of red; the issue
    // list carries the real message.
    expect(componentScore([], [])).toBe(100);
  });

  it("ignores issues about subjects outside the component's universe", () => {
    // A store issue must not invent a sixth subject in a product-only average.
    expect(componentScore([forStore({ severity: "critical" })], ["p:1", "p:2"])).toBe(100);
  });
});

describe("countBySeverity", () => {
  it("counts only what still counts against the score", () => {
    const counts = countBySeverity([
      issue({ severity: "critical" }),
      issue({ severity: "critical", status: "dismissed" }),
      issue({ severity: "warning", status: "assigned" }),
      issue({ severity: "opportunity", status: "resolved" }),
    ]);
    expect(counts).toEqual({ critical: 1, warning: 1, opportunity: 0 });
  });
});

describe("buildReport", () => {
  it("scores a clean catalog 100 and grades it excellent", () => {
    const report = buildReport({
      scope: "organization",
      scopeId: null,
      issues: [],
      subjects: productSubjects(3),
    });
    expect(report.score).toBe(100);
    expect(report.grade).toBe("excellent");
  });

  it("always returns all five components, even healthy ones", () => {
    // A card that vanishes when healthy is one a merchant cannot learn to read.
    const report = buildReport({
      scope: "organization",
      scopeId: null,
      issues: [forStore({ component: "checkout", severity: "critical" })],
      subjects: productSubjects(3),
    });
    expect(report.components).toHaveLength(5);
    expect(report.components.map((c) => c.key)).toEqual(COMPONENTS.map((c) => c.key));
  });

  it("applies the component weight to the headline number", () => {
    // Checkout is scored over the one store: 100 − 20 = 80. Weighted 0.25, that
    // is 5 points off an otherwise perfect 100.
    const report = buildReport({
      scope: "organization",
      scopeId: null,
      issues: [forStore({ component: "checkout", severity: "critical" })],
      subjects: productSubjects(3),
    });
    expect(report.components.find((c) => c.key === "checkout")?.score).toBe(80);
    expect(report.score).toBe(95);
  });

  it("rounds the headline from unrounded components, not rounded ones", () => {
    // Rounding each part first lets five small roundings move the number.
    const report = buildReport({
      scope: "organization",
      scopeId: null,
      issues: [
        forProduct(1, { component: "product_data", severity: "opportunity" }),
        forProduct(2, { component: "inventory", severity: "opportunity" }),
      ],
      subjects: productSubjects(3),
    });
    expect(Number.isInteger(report.score)).toBe(true);
    expect(report.score).toBe(100);
  });

  it("reports a trend delta against a previous snapshot", () => {
    const report = buildReport({
      scope: "site",
      scopeId: 3,
      issues: [forStore({ component: "checkout", severity: "critical" })],
      subjects: productSubjects(3),
      previous: { score: 90, at: "2026-07-30" },
    });
    expect(report.trend).toEqual({ delta: 5, since: "2026-07-30" });
  });

  it("has no trend when there is no history, rather than a zero delta", () => {
    // A zero delta would read as "no change" on a store never scored before — a
    // claim about history that does not exist.
    const report = buildReport({
      scope: "organization",
      scopeId: null,
      issues: [],
      subjects: productSubjects(1),
    });
    expect(report.trend).toBeNull();
  });

  it("moves when one issue among many is dismissed", () => {
    // The integration failure that led here: dismissing one of six criticals
    // has to change something, or triage feels broken.
    const subjects = productSubjects(3);
    const six = [1, 2, 3].flatMap((n) => [
      forProduct(n, { severity: "critical" }),
      forProduct(n, { severity: "critical" }),
    ]);
    const before = buildReport({ scope: "organization", scopeId: null, issues: six, subjects });

    const dismissed = six.map((i, idx) => (idx === 0 ? { ...i, status: "dismissed" as const } : i));
    const after = buildReport({
      scope: "organization",
      scopeId: null,
      issues: dismissed,
      subjects,
    });

    expect(after.score).toBeGreaterThan(before.score);
  });
});

describe("gradeFor", () => {
  it("maps the documented bands", () => {
    expect(gradeFor(0)).toBe("critical");
    expect(gradeFor(49)).toBe("critical");
    expect(gradeFor(50)).toBe("needs_work");
    expect(gradeFor(74)).toBe("needs_work");
    expect(gradeFor(75)).toBe("good");
    expect(gradeFor(89)).toBe("good");
    expect(gradeFor(90)).toBe("excellent");
    expect(gradeFor(100)).toBe("excellent");
  });
});

describe("compareIssues", () => {
  it("puts criticals first and is stable within a severity", () => {
    const list = [
      issue({ id: "iss_c", severity: "opportunity" }),
      issue({ id: "iss_b", severity: "critical" }),
      issue({ id: "iss_a", severity: "critical" }),
      issue({ id: "iss_d", severity: "warning" }),
    ];
    const sorted = [...list].sort(compareIssues).map((i) => i.id);
    expect(sorted).toEqual(["iss_a", "iss_b", "iss_d", "iss_c"]);
    // Two runs of the same catalog must list identically.
    expect([...list].sort(compareIssues).map((i) => i.id)).toEqual(sorted);
  });
});
