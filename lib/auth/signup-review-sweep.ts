import "server-only";

import { asc, gte, lt, and } from "drizzle-orm";
import { db, organizations } from "../db";
import { sendPlatformMail } from "../email";
import { signupReview } from "../email/templates";
import {
  SIGNUP_REVIEW_THRESHOLD,
  SIGNUP_REVIEW_WINDOW_MS,
  signupBursts,
} from "./signup-review";

/**
 * The sign-up review digest (G12) — the I/O half.
 *
 * Runs from the 09:00 cron beside the trial reminders. It **sends nothing on
 * a quiet day**: a daily "0 to review" trains whoever reads it to archive the
 * subject unread, which is the one outcome that makes the whole thing
 * pointless. A day with nothing over the threshold is reported in the cron's
 * JSON and nowhere else.
 *
 * **Not claimed before sending**, unlike the trial reminder and the cart
 * recovery mail, and the difference is who receives it: those go to a
 * merchant or a shopper, where a repeat is a spam complaint on Markii's
 * reputation. This goes to Markii's own inbox, where a duplicate digest after
 * a crashed run costs a second read. The window is anchored to `now`, so two
 * runs a minute apart report the same set rather than two halves.
 */

export type SignupReviewResult = {
  windowStart: string;
  windowEnd: string;
  threshold: number;
  signups: number;
  flaggedDomains: number;
  flaggedSignups: number;
  /** The flagged domains, largest burst first — so the cron's JSON says *what* without the mail. */
  domains: string[];
  sent: boolean;
  to: string | null;
  reason: string | null;
};

/**
 * Where the digest goes. `SIGNUP_REVIEW_TO` for a dedicated inbox, otherwise
 * the same address the contact form lands in — it is the one place a person
 * is already reading.
 */
export function signupReviewRecipient(): string {
  return (
    process.env.SIGNUP_REVIEW_TO?.trim() ||
    process.env.CONTACT_TO?.trim() ||
    "support@markii.shop"
  );
}

export async function sweepSignupReview(now: Date = new Date()): Promise<SignupReviewResult> {
  const since = new Date(now.getTime() - SIGNUP_REVIEW_WINDOW_MS);
  const threshold = SIGNUP_REVIEW_THRESHOLD;

  const rows = await db
    .select({
      slug: organizations.slug,
      name: organizations.name,
      billingEmail: organizations.billingEmail,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .where(and(gte(organizations.createdAt, since), lt(organizations.createdAt, now)))
    .orderBy(asc(organizations.createdAt));

  /**
   * The platform's own domain is never reviewed — see `signupBursts`. Read
   * here rather than in the pure half so a test can pass its own list.
   */
  const platformDomain = process.env.ROOT_DOMAIN?.trim().toLowerCase();
  const bursts = signupBursts(rows, threshold, platformDomain ? [platformDomain] : []);
  const base = {
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    threshold,
    signups: rows.length,
    flaggedDomains: bursts.length,
    flaggedSignups: bursts.reduce((n, b) => n + b.count, 0),
    domains: bursts.map((b) => b.domain),
  };

  if (bursts.length === 0) {
    return { ...base, sent: false, to: null, reason: "nothing over the threshold" };
  }

  const to = signupReviewRecipient();
  const mail = signupReview({ bursts, since, until: now, threshold, totalSignups: rows.length });
  const result = await sendPlatformMail({ to, subject: mail.subject, html: mail.html, text: mail.text });

  return result.sent
    ? { ...base, sent: true, to, reason: null }
    : { ...base, sent: false, to, reason: result.reason };
}
