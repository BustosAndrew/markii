import "server-only";

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, emailSuppressions, type DbHandle, type EmailSuppression } from "../db";

/**
 * The suppression list (§6).
 *
 * **This is what keeps the SES account alive.** AWS suspends senders above
 * roughly 5% bounce or 0.1% complaint, and those rates are measured across the
 * whole account — so one merchant repeatedly mailing a dead address can get
 * every merchant on the platform cut off. Suppression is therefore checked
 * before every merchant send, not offered as a setting.
 *
 * Scoping is per org, because a complaint is about *that merchant's* mail. An
 * address that reported one store as spam has not consented to hear from a
 * different store; equally it should not be denied a receipt from a store it
 * actually buys from.
 */

/** Lowercased consistently with the `email_suppressions_email_lower` CHECK. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The suppression blocking this address, or null. */
export async function suppressionFor(
  orgId: string,
  email: string,
  handle: DbHandle = db,
): Promise<EmailSuppression | null> {
  const [row] = await handle
    .select()
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.orgId, orgId),
        eq(emailSuppressions.email, normalizeEmail(email)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Suppress an address.
 *
 * Idempotent, and **a complaint is never downgraded**: if an address is already
 * suppressed for a spam complaint, a later soft signal must not overwrite that
 * with something a merchant might feel comfortable clearing.
 */
export async function suppress(input: {
  orgId: string;
  email: string;
  reason: EmailSuppression["reason"];
  detail?: string | null;
  sourceMessageId?: string | null;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  await db
    .insert(emailSuppressions)
    .values({
      orgId: input.orgId,
      email,
      reason: input.reason,
      detail: input.detail ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
    })
    .onConflictDoUpdate({
      target: [emailSuppressions.orgId, emailSuppressions.email],
      set: {
        reason: input.reason,
        detail: input.detail ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
      },
      // A recorded complaint stays a complaint — a later bounce or a merchant's
      // manual entry must not overwrite the strongest signal we have with one a
      // merchant is allowed to clear.
      setWhere: ne(emailSuppressions.reason, "complaint"),
    });
}

/**
 * Remove a suppression — merchant-initiated only, and only for the reasons a
 * merchant is entitled to overrule.
 *
 * **Complaints cannot be cleared here.** A recipient who marked mail as spam
 * withdrew consent; re-enabling that from a dashboard button would put an AWS
 * policy violation one click away, and the click would be made by someone with
 * an incentive to make it.
 */
export async function unsuppress(
  orgId: string,
  email: string,
): Promise<{ removed: boolean; reason?: string }> {
  const existing = await suppressionFor(orgId, email);
  if (!existing) return { removed: false, reason: "That address is not suppressed." };
  if (existing.reason === "complaint") {
    return {
      removed: false,
      reason:
        "This address reported your mail as spam. It cannot be re-enabled — sending again " +
        "would breach AWS's sending policy and put your domain's reputation at risk.",
    };
  }

  await db.delete(emailSuppressions).where(eq(emailSuppressions.id, existing.id));
  return { removed: true };
}

/** For the settings screen. Newest first — a merchant is looking for what just broke. */
export async function listSuppressions(
  orgId: string,
  limit = 100,
): Promise<EmailSuppression[]> {
  return db
    .select()
    .from(emailSuppressions)
    .where(eq(emailSuppressions.orgId, orgId))
    .orderBy(desc(emailSuppressions.createdAt))
    .limit(limit);
}

/**
 * Filter a recipient list down to addresses that may be mailed.
 *
 * One query rather than one per address: a broadcast to a large list is exactly
 * where a per-recipient check turns into a timeout, and a timeout here fails
 * open.
 */
export async function allowedRecipients(
  orgId: string,
  emails: string[],
): Promise<{ allowed: string[]; suppressed: EmailSuppression[] }> {
  const normalized = [...new Set(emails.map(normalizeEmail))];
  if (normalized.length === 0) return { allowed: [], suppressed: [] };

  const rows = await db
    .select()
    .from(emailSuppressions)
    .where(
      and(eq(emailSuppressions.orgId, orgId), inArray(emailSuppressions.email, normalized)),
    );

  const blocked = new Set(rows.map((r) => r.email));
  return {
    allowed: normalized.filter((e) => !blocked.has(e)),
    suppressed: rows,
  };
}
