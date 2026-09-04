import "server-only";

import { and, asc, eq, gt, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, organizations } from "../db";
import { GRANTING_SUBSCRIPTION_STATUSES } from "./mirror";
import { sendPlatformMail } from "../email";
import { trialEnding } from "../email/templates";

/**
 * "Your free month is ending" — the heads-up before a storefront stops serving.
 *
 * **Markii's own mail about Markii's own billing**, so it goes via
 * `sendPlatformMail` (Resend, from `markii.shop`) and never through a merchant's
 * SES identity. Sending a dunning notice from the merchant's own domain would
 * put Markii's commercial relationship on their sending reputation.
 *
 * The engine is trivial; the selection rules are the feature.
 */

/**
 * How far ahead to warn. Long enough to act on — find a card, get an approval —
 * and short enough that the trial is real to them rather than an abstraction
 * they will forget.
 */
export const WARN_WITHIN_MS = 3 * 24 * 60 * 60_000;

/** Bounded per run so one enormous signup batch cannot starve the rest. */
const BATCH = 200;

export type TrialSweepResult = {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  problems: string[];
};

/**
 * One reminder per org, ever.
 *
 * `trial_reminder_sent_at` is claimed **before** the send, exactly as the
 * abandoned-cart sweep claims a cart: the job runs daily against a window three
 * days wide, so an unclaimed row would be mailed on every run inside it. A crash
 * between claim and send costs one missed reminder; the reverse costs three
 * identical emails and a merchant who trusts Markii's mail less.
 */
export async function sweepTrialReminders(now: Date = new Date()): Promise<TrialSweepResult> {
  const result: TrialSweepResult = {
    considered: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    problems: [],
  };

  const horizon = new Date(now.getTime() + WARN_WITHIN_MS);

  const candidates = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      billingEmail: organizations.billingEmail,
      freeTrialEndsAt: organizations.freeTrialEndsAt,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      subscriptionStatus: organizations.subscriptionStatus,
    })
    .from(organizations)
    .where(
      and(
        isNull(organizations.trialReminderSentAt),
        /**
         * Still running. An org whose trial already lapsed is **not** mailed by
         * this job — the moment for a heads-up has passed, and "your trial ends
         * in -2 days" is the kind of message that reads as a broken system.
         */
        gt(organizations.freeTrialEndsAt, now),
        lt(organizations.freeTrialEndsAt, horizon),
        /**
         * Nothing that grants a plan.
         *
         * **Not simply `stripe_subscription_id IS NULL`.** An `incomplete`
         * subscription — one created but never paid — leaves that id set while
         * granting nothing, so the narrower test would silently exclude exactly
         * the merchant heading for a dark storefront who most needs telling. The
         * status list is the same one `statusGrantsPlan` uses, imported rather
         * than retyped so the two cannot drift.
         */
        notGranting(),
      ),
    )
    .orderBy(asc(organizations.freeTrialEndsAt))
    .limit(BATCH);

  result.considered = candidates.length;

  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://markii.shop").replace(/\/+$/, "");
  const subscribeUrl = `${base}/dashboard/settings/subscription`;

  for (const org of candidates) {
    const endsAt = org.freeTrialEndsAt;
    if (!endsAt) {
      result.skipped += 1;
      continue;
    }

    /**
     * Claim first. The update is conditional on the marker still being null, so
     * two overlapping runs cannot both win the same row — the second updates
     * zero rows and skips.
     */
    const claimed = await db
      .update(organizations)
      .set({ trialReminderSentAt: now, updatedAt: new Date() })
      .where(and(eq(organizations.id, org.id), isNull(organizations.trialReminderSentAt)))
      .returning({ id: organizations.id });
    if (claimed.length === 0) {
      result.skipped += 1;
      continue;
    }

    const daysLeft = Math.max(
      0,
      Math.floor((endsAt.getTime() - now.getTime()) / (24 * 60 * 60_000)),
    );

    const mail = trialEnding({
      orgName: org.name,
      endsOn: endsAt.toISOString().slice(0, 10),
      daysLeft,
      subscribeUrl,
    });

    const sent = await sendPlatformMail({
      to: org.billingEmail,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });

    if (sent.sent) {
      result.sent += 1;
    } else {
      /**
       * The claim is **not** rolled back. Releasing it would re-queue the org on
       * the next run, and a provider that just refused one send will usually
       * refuse the next — turning a failed reminder into a daily retry against
       * the same address. Reported instead, which is where an operator looks.
       */
      result.failed += 1;
      result.problems.push(`${org.id}: ${sent.reason}`);
    }
  }

  return result;
}

/**
 * "Has no subscription that grants a plan", as a SQL predicate.
 *
 * Shared by the sweep and the standing count so a merchant cannot be considered
 * subscribed by one and unsubscribed by the other — the same reason
 * `lib/billing/mirror.ts` exists for the action and the webhook.
 */
function notGranting() {
  return or(
    isNull(organizations.stripeSubscriptionId),
    isNull(organizations.subscriptionStatus),
    notInArray(organizations.subscriptionStatus, [...GRANTING_SUBSCRIPTION_STATUSES]),
  );
}

/** Exported for the cron's response body — a count is cheaper than a scan to read. */
export async function orgsOutOfStanding(now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organizations)
    .where(and(notGranting(), lt(organizations.freeTrialEndsAt, now)));
  return row?.n ?? 0;
}
