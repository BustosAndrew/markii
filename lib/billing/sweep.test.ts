import { describe, expect, it } from "vitest";
import { summariseSweep, type OrgSweepOutcome } from "./sweep";

/**
 * The summary is the alerting surface — it is what an operator reads to decide
 * whether last night's billing run was healthy. Getting the arithmetic wrong
 * here does not break billing; it makes a broken run *look fine*, which is the
 * worse failure and the one nothing downstream would catch.
 */

const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-01T00:00:00.000Z");

function outcome(over: Partial<OrgSweepOutcome> & { orgId: string }): OrgSweepOutcome {
  return { closed: null, invoiced: null, ...over };
}

const closedOk = (feeMinor: number, alreadyClosed = false) => ({
  ok: true as const,
  assessmentIds: ["fee_1"],
  feeMinor,
  alreadyClosed,
});

const invoicedOk = (chargedMinor: number, currency: string, charging: boolean) => ({
  ok: true as const,
  billedCount: 1,
  chargedMinor,
  currency,
  skipped: [],
  charging,
});

function summarise(outcomes: OrgSweepOutcome[]) {
  return summariseSweep(PERIOD_START, PERIOD_END, false, outcomes);
}

describe("summariseSweep", () => {
  it("totals charges per currency instead of adding yen to cents", () => {
    const result = summarise([
      outcome({ orgId: "org_us", invoiced: invoicedOk(5_000, "USD", true) }),
      outcome({ orgId: "org_us2", invoiced: invoicedOk(2_500, "usd", true) }),
      outcome({ orgId: "org_jp", invoiced: invoicedOk(9_000, "JPY", true) }),
    ]);

    // 7500 USD cents and 9000 yen. A single total would read as 16,500 of
    // nothing (D31).
    expect(result.chargedByCurrency).toEqual({ USD: 7_500, JPY: 9_000 });
  });

  it("counts an org as billed only when money was actually raised", () => {
    const result = summarise([
      // Settled a zero-fee period: real work, no charge.
      outcome({ orgId: "org_zero", invoiced: invoicedOk(0, "USD", false) }),
      outcome({ orgId: "org_paid", invoiced: invoicedOk(4_200, "USD", true) }),
    ]);

    expect(result.orgsBilled).toBe(1);
    expect(result.chargedByCurrency).toEqual({ USD: 4_200 });
  });

  it("does not count a period that was already closed as newly closed", () => {
    const result = summarise([
      outcome({ orgId: "org_new", closed: closedOk(1_000) }),
      outcome({ orgId: "org_rerun", closed: closedOk(1_000, true) }),
    ]);

    // A re-run must not report that it closed the same period a second time.
    expect(result.orgsClosed).toBe(1);
    expect(result.orgsConsidered).toBe(2);
  });

  it("surfaces a failure in either step", () => {
    const result = summarise([
      outcome({
        orgId: "org_close_failed",
        closed: { ok: false, assessmentIds: [], feeMinor: 0, alreadyClosed: false, error: "boom" },
      }),
      outcome({
        orgId: "org_bill_failed",
        closed: closedOk(500),
        invoiced: {
          ok: false,
          billedCount: 0,
          chargedMinor: 0,
          currency: "USD",
          skipped: [],
          error: "Stripe unreachable",
        charging: false,
        },
      }),
      outcome({ orgId: "org_fine", closed: closedOk(500), invoiced: invoicedOk(500, "USD", true) }),
    ]);

    expect(result.orgsFailed).toBe(2);
    // A failed run still reports what did succeed — the healthy org billed.
    expect(result.chargedByCurrency).toEqual({ USD: 500 });
  });

  it("excludes a failed org's charges from the totals", () => {
    const result = summarise([
      outcome({
        orgId: "org_failed",
        invoiced: {
          ok: false,
          billedCount: 0,
          chargedMinor: 999,
          currency: "USD",
          skipped: [],
          charging: false,
          error: "boom",
        },
      }),
    ]);

    // The amount on a failed outcome is not money that moved.
    expect(result.chargedByCurrency).toEqual({});
    expect(result.orgsFailed).toBe(1);
  });

  it("reports an empty run honestly rather than as a success", () => {
    const result = summarise([]);

    expect(result.orgsConsidered).toBe(0);
    expect(result.orgsClosed).toBe(0);
    expect(result.orgsBilled).toBe(0);
    expect(result.chargedByCurrency).toEqual({});
  });

  it("carries the period and dry-run flag through untouched", () => {
    const result = summariseSweep(PERIOD_START, PERIOD_END, true, []);

    expect(result.periodStart).toBe("2026-07-01T00:00:00.000Z");
    expect(result.periodEnd).toBe("2026-08-01T00:00:00.000Z");
    expect(result.dryRun).toBe(true);
  });
});
