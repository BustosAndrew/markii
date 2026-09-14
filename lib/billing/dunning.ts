/**
 * Dunning — the ladder between a failed renewal and a lost merchant (D10,
 * decided 2026-09-14).
 *
 * The rule the whole thing serves: **taking a paying merchant's store offline
 * over a failed card is a churn event, not a collection strategy.** So the
 * storefront is the *last* thing to go, weeks after the card failed, and what
 * restricts first is the merchant's own ability to grow on an unpaid plan.
 *
 * **Derived from a timestamp and the clock on every request.** `past_due_since`
 * is written once, on the transition into `past_due`; the step is computed
 * here, never stored. Same rule as account standing and membership status: a
 * stored step would sit at "grace" until a job moved it, and the job is the
 * thing that will not run the night it matters.
 *
 * The ladder, in days since the first failed payment:
 *
 * | Day | Step                | What is held                                              |
 * |-----|---------------------|-----------------------------------------------------------|
 * | 0   | `grace`             | Nothing. Banner and email only.                           |
 * | 7   | `restricted_growth` | Going live on new storefronts; minting API tokens.        |
 * | 14  | `restricted_writes` | Every mutation except `billing.*` — the trial-hold shape. |
 * | 30  | `suspended`         | The storefront stops serving.                             |
 *
 * Emails go at day 0, 7 and 13 — the last one the day *before* writes are
 * held, so the merchant is told before the thing happens rather than by it.
 *
 * `unpaid` — where Stripe gives up retrying — does **not** reset or accelerate
 * this. The plan drops to the floor at that point (`statusGrantsPlan`), which
 * is entitlements, not standing; the storefront still runs to day 30.
 */

export const DUNNING_STATUSES = ["past_due", "unpaid"] as const;

export type DunningStep = "grace" | "restricted_growth" | "restricted_writes" | "suspended";

const DAY_MS = 24 * 60 * 60_000;

/** Day thresholds, in the order they are reached. */
export const DUNNING_LADDER: { step: DunningStep; day: number }[] = [
  { step: "grace", day: 0 },
  { step: "restricted_growth", day: 7 },
  { step: "restricted_writes", day: 14 },
  { step: "suspended", day: 30 },
];

/** The days on which a notice is sent. 13, not 14: told before it happens. */
export const DUNNING_NOTICE_DAYS = [0, 7, 13] as const;

export type Dunning = {
  step: DunningStep;
  /** When the episode began — the first failed renewal. */
  since: Date;
  /** Whole days into the episode, floored. */
  day: number;
  /** When the next step is reached, or null at the last one. */
  nextStepAt: Date | null;
  /** The next step, or null at the last one. */
  nextStep: DunningStep | null;
  holds: {
    /** New storefronts going live, new API tokens. */
    growth: boolean;
    /** Every mutation except `billing.*`. */
    writes: boolean;
    /** The storefront itself. */
    storefront: boolean;
  };
};

export type DunningOrg = {
  subscriptionStatus: string | null;
  pastDueSince: Date | null;
};

export function inDunningStatus(status: string | null | undefined): boolean {
  return (DUNNING_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * The org's dunning state, or null when it is not in one.
 *
 * Null for a `past_due` row with no `past_due_since`: that is a row the mirror
 * wrote before this existed, and inventing a start date would put a merchant
 * on a ladder at a rung nobody can justify. It is treated as grace until the
 * next status change writes the date.
 */
export function dunningFor(org: DunningOrg, now: Date = new Date()): Dunning | null {
  if (!inDunningStatus(org.subscriptionStatus) || !org.pastDueSince) return null;

  const since = org.pastDueSince;
  const day = Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));

  let index = 0;
  for (let i = 0; i < DUNNING_LADDER.length; i++) {
    if (day >= DUNNING_LADDER[i].day) index = i;
  }
  const current = DUNNING_LADDER[index];
  const next = DUNNING_LADDER[index + 1] ?? null;

  return {
    step: current.step,
    since,
    day,
    nextStepAt: next ? new Date(since.getTime() + next.day * DAY_MS) : null,
    nextStep: next?.step ?? null,
    holds: {
      growth: index >= 1,
      writes: index >= 2,
      storefront: index >= 3,
    },
  };
}

/**
 * Which notice, if any, is due on this day of the episode.
 *
 * Each notice has a window: day 0 until the growth rung, day 7 until the eve
 * of the writes rung, and day 13 **that day only** — its copy says "tomorrow",
 * and a day-15 send of it would be false. A sweep that missed day 7 still
 * sends the day-7 notice on day 9 rather than skipping to silence; a sweep
 * that missed day 13 costs that one warning, which is the standing rule for
 * every cron here: a broken job loses a warning, never a store.
 */
export function noticeDueOn(day: number): 0 | 7 | 13 | null {
  if (day < 0) return null;
  if (day < 7) return 0;
  if (day < 13) return 7;
  if (day === 13) return 13;
  return null;
}

/** One sentence per step, shared by the API, the banner copy and the emails. */
export function describeDunning(d: Dunning): string {
  switch (d.step) {
    case "grace":
      return "A renewal payment failed and Stripe is retrying. Everything keeps working while it does — update your card to clear it.";
    case "restricted_growth":
      return "A renewal payment has been failing for a week. New storefronts cannot go live and new API tokens cannot be created until it is paid.";
    case "restricted_writes":
      return "A renewal payment has been failing for two weeks. Your storefront is still serving, but changes are on hold until the invoice is paid.";
    case "suspended":
      return "A renewal payment has been failing for a month, so the storefront has stopped serving. Paying the invoice brings it back immediately.";
  }
}
