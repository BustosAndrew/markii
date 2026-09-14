import "server-only";

import { and, inArray, isNotNull } from "drizzle-orm";
import { db, dunningNotices, organizations } from "../db";
import { sendPlatformMail } from "../email";
import { dunningNotice } from "../email/templates/dunning";
import { DUNNING_STATUSES, dunningFor, noticeDueOn } from "./dunning";

/**
 * The dunning email sequence (D10): day 0, 7 and 13 of a failing renewal.
 *
 * **Markii's own mail**, so `sendPlatformMail` (Resend, `markii.shop`) and
 * never a merchant's SES identity. Stripe's own failed-payment emails are
 * switched off for the platform account, so these are the only notices.
 *
 * Run from the daily 09:00 cron beside the trial reminder, and — like every
 * cron here — **it enforces nothing.** The ladder's holds are derived from
 * `past_due_since` on every request; a broken sweep costs a warning, never a
 * store. Each notice is claimed in `dunning_notices` before the send, keyed on
 * the episode start, so a daily run inside a notice's window sends once.
 */

/** Bounded per run so one bad night for a card network cannot starve the rest. */
const BATCH = 200;

export type DunningSweepResult = {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  problems: string[];
};

export async function sweepDunningNotices(now: Date = new Date()): Promise<DunningSweepResult> {
  const result: DunningSweepResult = { considered: 0, sent: 0, skipped: 0, failed: 0, problems: [] };

  const candidates = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      billingEmail: organizations.billingEmail,
      subscriptionStatus: organizations.subscriptionStatus,
      pastDueSince: organizations.pastDueSince,
    })
    .from(organizations)
    .where(
      and(
        inArray(organizations.subscriptionStatus, [...DUNNING_STATUSES]),
        isNotNull(organizations.pastDueSince),
      ),
    )
    .limit(BATCH);

  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://markii.shop").replace(/\/$/, "");
  const billingUrl = `${base}/dashboard/billing`;

  for (const org of candidates) {
    result.considered += 1;
    const dunning = dunningFor(org, now);
    if (!dunning) {
      result.skipped += 1;
      continue;
    }
    const notice = noticeDueOn(dunning.day);
    if (notice === null) {
      result.skipped += 1;
      continue;
    }

    /**
     * Claim first — an insert that hits the episode/step unique index is a
     * notice already sent, and the second of two overlapping runs simply
     * inserts nothing and moves on.
     */
    const claimed = await db
      .insert(dunningNotices)
      .values({ orgId: org.id, pastDueSince: dunning.since, step: notice, sentAt: now })
      .onConflictDoNothing()
      .returning({ id: dunningNotices.id });
    if (claimed.length === 0) {
      result.skipped += 1;
      continue;
    }

    const mail = dunningNotice({
      orgName: org.name,
      notice,
      failedOn: dunning.since.toISOString().slice(0, 10),
      nextStepOn: dunning.nextStepAt?.toISOString().slice(0, 10) ?? null,
      billingUrl,
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
       * The claim stays. Releasing it would re-send to an address the
       * provider just refused, every day, for as long as the episode lasts.
       * Reported instead, where an operator looks.
       */
      result.failed += 1;
      result.problems.push(`${org.id}: ${sent.reason}`);
    }
  }

  return result;
}
