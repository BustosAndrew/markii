import { limitFromEnv } from "../rate-limit";

/**
 * Sending caps for merchant mail (G12) — the pure half.
 *
 * **Why merchant mail needs a cap at all.** Every merchant sends through one
 * SES account, and AWS suspends that account on its **account-wide** bounce
 * and complaint rates. A merchant's own verified domain does not change that
 * — it changes the From line, not whose account the reputation belongs to. So
 * the shared resource G12 names is real: one new merchant mailing a bad set
 * of addresses can cost every other merchant their receipts. Suppression stops
 * the *second* send to a bad address; this bounds how many first sends a
 * merchant nobody knows yet can make in a day.
 *
 * **Who gets which cap, in the order it is decided:**
 *
 * 1. **`probation`** — any merchant, however established, whose last 30 days
 *    of mail bounced or drew complaints at the rates AWS reviews an account
 *    at. Reputation outranks tenure: an old account sending to a bad list is
 *    exactly the case the cap exists for.
 * 2. **`trial`** — no plan-granting subscription. No card was taken (D45), so
 *    the account cost its creator one email address, and the free month is the
 *    shape abuse takes.
 * 3. **`new`** — paying, but younger than the established age. Real money is
 *    behind it, so the cap is ten times higher; reputation is not proven yet.
 * 4. **`established`** — paying, old enough, clean. No cap here; SES's own
 *    account quota is the ceiling.
 *
 * **Nothing is exempt, including receipts.** The tension is real — D44 says a
 * store that takes an order and sends nothing is broken. But the trial cap is
 * well above what a store in its first month sells in a day, subscribing
 * lifts it immediately, and a capped receipt is recorded and reported on the
 * order timeline rather than lost silently. An exemption for receipts would
 * be an exemption for the abuser too: a free product makes "receipt" mean
 * "any address the abuser types into a checkout form".
 *
 * Derived per send from `email_deliveries`, never stored — the same reason
 * standing and membership status are derived (D34): nothing here runs on a
 * clock that could flip a stored tier when a merchant ages into the next one.
 */

export type SendingTier = "probation" | "trial" | "new" | "established";

/** Daily caps per tier, over a rolling 24 hours. `null` is no cap. */
export const SENDING_CAPS: Record<SendingTier, number | null> = {
  probation: limitFromEnv("MERCHANT_MAIL_CAP_PROBATION", 100),
  trial: limitFromEnv("MERCHANT_MAIL_CAP_TRIAL", 100),
  new: limitFromEnv("MERCHANT_MAIL_CAP_NEW", 1000),
  established: null,
};

/** Days a paying account must exist before it is considered established. */
export const ESTABLISHED_AFTER_DAYS = limitFromEnv("MERCHANT_MAIL_ESTABLISHED_DAYS", 30);

/**
 * The reputation test.
 *
 * The rates are where AWS places an account **under review** — 5% bounces,
 * 0.1% complaints — so a merchant is capped at the point their mail starts to
 * put the shared account at risk, not after it has. Measured over 30 days so
 * one bad afternoon does not linger and one good afternoon does not wash out a
 * bad month.
 *
 * **A minimum sample**, or the first bounce of a merchant's first ten sends is
 * a 10% bounce rate. Below it the account is judged on tenure and payment
 * alone.
 */
export const REPUTATION = {
  windowDays: 30,
  minSample: 50,
  bounceRate: 0.05,
  complaintRate: 0.001,
} as const;

/** Mail that left over the reputation window. `sent` includes what later bounced or drew a complaint. */
export type SendingHistory = {
  sent: number;
  bounced: number;
  complained: number;
};

export type SendingCapInput = {
  /** Holds a subscription that grants a plan (`statusGrantsPlan`). */
  paying: boolean;
  accountCreatedAt: Date;
  /** Messages that left in the last 24 hours. */
  sentLast24h: number;
  history: SendingHistory;
  now?: Date;
};

export type SendingCap = {
  tier: SendingTier;
  dailyLimit: number | null;
  sentLast24h: number;
  /** Null when uncapped. Floored at 0. */
  remaining: number | null;
  allowed: boolean;
  /** Why this tier — shown to the merchant as-is. */
  reason: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the history crosses either AWS review rate, given enough of it to judge. */
export function reputationAtRisk(history: SendingHistory): boolean {
  if (history.sent < REPUTATION.minSample) return false;
  return (
    history.bounced / history.sent >= REPUTATION.bounceRate ||
    history.complained / history.sent >= REPUTATION.complaintRate
  );
}

export function sendingTierFor(input: SendingCapInput): { tier: SendingTier; reason: string } {
  const now = input.now ?? new Date();

  if (reputationAtRisk(input.history)) {
    const { sent, bounced, complained } = input.history;
    return {
      tier: "probation",
      reason:
        `Of ${sent} emails sent in the last ${REPUTATION.windowDays} days, ${bounced} bounced and ` +
        `${complained} were reported as spam — above the rates that put shared sending at risk. ` +
        "Sending is capped until that improves.",
    };
  }

  if (!input.paying) {
    return {
      tier: "trial",
      reason: "New accounts without a subscription have a daily sending cap. Subscribing raises it.",
    };
  }

  const ageDays = (now.getTime() - input.accountCreatedAt.getTime()) / DAY_MS;
  if (ageDays < ESTABLISHED_AFTER_DAYS) {
    const daysLeft = Math.max(1, Math.ceil(ESTABLISHED_AFTER_DAYS - ageDays));
    return {
      tier: "new",
      reason:
        `Accounts have a higher daily sending cap for their first ${ESTABLISHED_AFTER_DAYS} days ` +
        `while their sending reputation is established. It lifts in ${daysLeft} ` +
        `day${daysLeft === 1 ? "" : "s"}.`,
    };
  }

  return { tier: "established", reason: "No daily sending cap." };
}

/**
 * The full decision for one send.
 *
 * `sentLast24h` counts what has **already** left, so a count equal to the cap
 * means the cap is spent and this send is refused — unlike the request
 * limiters, which increment before they ask.
 */
export function sendingCapFor(input: SendingCapInput): SendingCap {
  const { tier, reason } = sendingTierFor(input);
  const dailyLimit = SENDING_CAPS[tier];

  if (dailyLimit === null) {
    return { tier, dailyLimit, sentLast24h: input.sentLast24h, remaining: null, allowed: true, reason };
  }

  return {
    tier,
    dailyLimit,
    sentLast24h: input.sentLast24h,
    remaining: Math.max(0, dailyLimit - input.sentLast24h),
    allowed: input.sentLast24h < dailyLimit,
    reason,
  };
}

/** The refusal a capped send records and returns. */
export function cappedReason(cap: SendingCap): string {
  return (
    `Daily sending cap reached: ${cap.sentLast24h} of ${cap.dailyLimit} emails in the last 24 ` +
    `hours. ${cap.reason}`
  );
}
