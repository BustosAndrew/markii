import { describe, expect, it } from "vitest";
import { currentPeriod, periodStartingAt, previousPeriod } from "./meter";

/**
 * The scheduler closes whatever `previousPeriod` returns, and a closed period
 * cannot be reopened — the unique key on `(orgId, periodStart)` makes a second
 * close a read. So an off-by-one month here is not a scheduling annoyance; it
 * freezes the wrong window and the remainder is never assessed at all.
 */

describe("previousPeriod", () => {
  it("returns the month that just ended, ending exactly where the current one starts", () => {
    const now = new Date("2026-08-10T14:23:00.000Z");

    const previous = previousPeriod(now);

    expect(previous.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(previous.end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // Abutting exactly: no sale can fall in the gap between two periods, and
    // none can be counted by both.
    expect(previous.end.getTime()).toBe(currentPeriod(now).start.getTime());
  });

  it("crosses the year boundary backwards", () => {
    const previous = previousPeriod(new Date("2026-01-04T00:00:00.000Z"));

    expect(previous.start.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(previous.end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("has always ended by the time it is returned", () => {
    // The property the close guard depends on: a period the scheduler is
    // offered can never still be receiving sales.
    for (const iso of [
      "2026-03-01T00:00:00.000Z",
      "2026-03-01T00:00:00.001Z",
      "2026-03-31T23:59:59.999Z",
      "2026-12-31T23:59:59.999Z",
    ]) {
      const now = new Date(iso);
      expect(previousPeriod(now).end.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it("never returns the period containing now", () => {
    const now = new Date("2026-08-10T14:23:00.000Z");

    expect(previousPeriod(now).start.getTime()).toBeLessThan(currentPeriod(now).start.getTime());
  });
});

describe("periodStartingAt", () => {
  it("normalises any instant to the month containing it", () => {
    for (const iso of [
      "2026-07-01T00:00:00.000Z",
      "2026-07-15T09:00:00.000Z",
      "2026-07-31T23:59:59.999Z",
    ]) {
      const period = periodStartingAt(new Date(iso));
      expect(period.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(period.end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    }
  });

  it("agrees with previousPeriod when handed that period's own start", () => {
    // The catch-up path: passing ?period= the value a previous run would have
    // used must close exactly the same window.
    const previous = previousPeriod(new Date("2026-08-10T00:00:00.000Z"));
    const explicit = periodStartingAt(previous.start);

    expect(explicit.start.getTime()).toBe(previous.start.getTime());
    expect(explicit.end.getTime()).toBe(previous.end.getTime());
  });

  it("yields an invalid date the route can detect rather than a silent default", () => {
    // `new Date("not-a-date")` must not quietly become the current month and
    // close a live period.
    expect(Number.isNaN(periodStartingAt(new Date("not-a-date")).start.getTime())).toBe(true);
  });
});
