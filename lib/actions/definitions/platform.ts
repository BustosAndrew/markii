import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ApiError, conflict, forbidden, notFound } from "../../api";
import { removeAllMfaFactors } from "../../auth/admin";
import { revokeAllUserSessions } from "../../auth/sessions";
import { mfaRecoveryCodes, organizations, sql, staff } from "../../db";
import { sendPlatformMail } from "../../email";
import { mfaReset } from "../../email/templates/mfa-reset";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Platform actions (G12) — what a Markii operator may do to a merchant's org.
 *
 * Registry actions like every other mutation (§22 rule 1), so they get the
 * same validation, step-up, audit and dry-run as a merchant's own — and so a
 * merchant's audit log shows "Markii operator suspended this organization"
 * next to their own history, which is the honest place for it. Held behind
 * `platform.operate`, which no staff role can hold (`PLATFORM_PERMISSIONS`).
 *
 * `riskTier: "high"` and `requiresStepUp: true` both apply: removing a store
 * from the internet is the most consequential thing this registry can do, and
 * an operator is a person on a session who can produce a fresh factor. The
 * human-approval gate (rule 3) refuses non-human actors, which no operator is.
 */

async function targetOrg(ctx: ActionContext) {
  // The operator's actor carries the *target* org (see `operatorActorFor`).
  if (ctx.actor.type !== "operator") throw forbidden("Only a platform operator may do this.");
  if (!ctx.actor.orgId) throw notFound("Organization");
  const [org] = await ctx.db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      suspendedAt: organizations.suspendedAt,
      suspendedReason: organizations.suspendedReason,
      suspendedBy: organizations.suspendedBy,
    })
    .from(organizations)
    .where(eq(organizations.id, ctx.actor.orgId))
    .limit(1);
  if (!org) throw notFound("Organization");
  return org;
}

export const suspendOrg = defineAction({
  id: "platform.suspendOrg",
  description:
    "Suspend a merchant organization: the storefront stops serving, checkouts, downloads and " +
    "membership renewals halt, and every write except billing is refused with ACCOUNT_SUSPENDED. " +
    "Reads are untouched. Markii-only; the reason is recorded in the merchant's audit log.",
  input: z
    .object({
      /**
       * Recorded on the org row and in the audit log — **which the merchant's
       * owner and administrators can read** (`org.audit`). So it is not a
       * private note: write it as the thing you would say to them, because
       * you are. The standing payload does not repeat it (its message is
       * "contact support"), but the grounds belong in their audit trail — a
       * suspension a merchant cannot see the reason for in their own log is
       * not an audit trail. Required: a suspension with no reason is one
       * nobody can review later.
       */
      reason: z.string().trim().min(3).max(1000),
    })
    .strict(),
  permission: "platform.operate",
  riskTier: "high",
  requiresStepUp: true,
  undoable: true,
  inverse: () => ({
    actionId: "platform.unsuspendOrg",
    input: {},
    conflictCheck: "none" as const,
  }),
  async run(input, ctx) {
    const org = await targetOrg(ctx);
    if (org.suspendedAt) {
      throw conflict(
        `${org.slug} is already suspended (since ${org.suspendedAt.toISOString().slice(0, 10)}).`,
      );
    }

    const now = new Date();
    if (!ctx.dryRun) {
      await ctx.db
        .update(organizations)
        .set({
          suspendedAt: now,
          suspendedReason: input.reason,
          suspendedBy: ctx.actor.id,
          updatedAt: now,
        })
        .where(eq(organizations.id, org.id));
    }

    ctx.recordDiff({
      entity: "organization",
      entityId: org.id,
      path: "suspendedAt",
      before: null,
      after: now.toISOString(),
    });
    ctx.recordDiff({
      entity: "organization",
      entityId: org.id,
      path: "suspendedReason",
      before: null,
      after: input.reason,
    });

    return {
      orgId: org.id,
      slug: org.slug,
      suspendedAt: now.toISOString(),
      note: ctx.dryRun
        ? "Dry run: nothing was written."
        : "The storefront stops serving on the next request; nothing has to sweep.",
    };
  },
});

export const unsuspendOrg = defineAction({
  id: "platform.unsuspendOrg",
  description:
    "Lift a platform suspension. Standing returns to whatever billing says — a lapsed trial " +
    "or a dunning hold still applies on its own terms. Markii-only.",
  input: z.object({}).strict(),
  permission: "platform.operate",
  riskTier: "high",
  requiresStepUp: true,
  /**
   * Not undoable: the inverse would re-suspend with the *old* reason, and a
   * suspension is a fresh decision with its own reason every time.
   */
  undoable: false,
  async run(_input, ctx) {
    const org = await targetOrg(ctx);
    if (!org.suspendedAt) throw conflict(`${org.slug} is not suspended.`);

    if (!ctx.dryRun) {
      await ctx.db
        .update(organizations)
        .set({ suspendedAt: null, suspendedReason: null, suspendedBy: null, updatedAt: new Date() })
        .where(eq(organizations.id, org.id));
    }

    ctx.recordDiff({
      entity: "organization",
      entityId: org.id,
      path: "suspendedAt",
      before: org.suspendedAt.toISOString(),
      after: null,
    });
    ctx.recordDiff({
      entity: "organization",
      entityId: org.id,
      path: "suspendedReason",
      before: org.suspendedReason,
      after: null,
    });

    return {
      orgId: org.id,
      slug: org.slug,
      wasSuspendedSince: org.suspendedAt.toISOString(),
      note: ctx.dryRun
        ? "Dry run: nothing was written."
        : "Reinstated. Billing standing applies as before.",
    };
  },
});

export const resetMfa = defineAction({
  id: "platform.resetMfa",
  description:
    "Remove every authenticator from one staff member of this organization, void their unused " +
    "recovery codes and sign them out everywhere, so they re-enrol at their next sign-in. For a " +
    "merchant who has lost both their authenticator and their recovery codes. Markii-only; the " +
    "member is emailed, and the reset lands in the organization's audit log.",
  input: z
    .object({
      userId: z.string().uuid(),
      /**
       * How the operator confirmed this is really the account holder — the
       * whole risk of this action is someone talking support into it. Recorded
       * in the audit log, so "who reset it, and on what evidence" can be
       * answered later. Required and not trivially short.
       */
      verification: z.string().trim().min(10).max(1000),
    })
    .strict(),
  permission: "platform.operate",
  riskTier: "high",
  requiresStepUp: true,
  /** Nothing to restore: the old secret is gone at Supabase, by design. */
  undoable: false,
  async run(input, ctx) {
    const org = await targetOrg(ctx);

    const [member] = await ctx.db
      .select({ userId: staff.userId, email: staff.email, role: staff.role })
      .from(staff)
      .where(and(eq(staff.orgId, org.id), eq(staff.userId, input.userId)))
      .limit(1);
    // A 404 either way: this org has no such member, whatever else exists.
    if (!member?.userId) throw notFound("Staff member");

    /**
     * An operator may not reset their own factor. Doing so would let whoever
     * holds an operator's password — but not their phone — remove the one
     * thing standing between them and every merchant's store. A second
     * operator can do it for them.
     */
    if (member.userId === ctx.actor.id) {
      throw forbidden("An operator cannot reset their own two-factor authentication.");
    }

    const [{ n: factorCount }] = await sql<{ n: number }[]>`
      select count(*)::int as n from auth.mfa_factors where user_id = ${member.userId}::uuid
    `;
    /**
     * The notice goes to the **account's** email, not `staff.email`. The staff
     * row keeps the address the invitation went to, and a Secure Email Change
     * does not rewrite it — so a merchant who changed their address would be
     * told about a reset of their own account at one they may no longer read.
     */
    const [account] = await sql<{ email: string | null }[]>`
      select email from auth.users where id = ${member.userId}::uuid
    `;
    const notifyTo = account?.email ?? member.email;

    if (ctx.dryRun) {
      return {
        userId: member.userId,
        email: member.email,
        factorsToRemove: factorCount,
        note: "Dry run: nothing was removed and no one was signed out.",
      };
    }

    /**
     * The irreversible external call goes **first and in `run`**, never as a
     * post-commit effect — the same rule as a processor refund. An effect that
     * failed would leave an audit row saying the reset happened while the old
     * factor still worked.
     */
    const removal = await removeAllMfaFactors(member.userId);
    if (!removal.ok) {
      throw new ApiError(
        "INTERNAL",
        502,
        `Supabase refused to remove the authenticator (${removal.removed} of ${factorCount} removed). ` +
          "Nothing was reported as reset; try again.",
        { reason: removal.reason },
      );
    }

    // Void what the old enrolment issued. Used codes stay as history.
    await ctx.db
      .delete(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, member.userId), isNull(mfaRecoveryCodes.usedAt)));
    const sessionsEnded = await revokeAllUserSessions(member.userId);

    ctx.recordDiff({
      entity: "user",
      entityId: member.userId,
      path: "mfaFactors",
      before: factorCount,
      after: 0,
    });
    /**
     * In the diff, not only the input, because the org's audit view shows the
     * diff: the merchant can read on what evidence support reset their account,
     * which is the answer they need if they never asked for it.
     */
    ctx.recordDiff({
      entity: "user",
      entityId: member.userId,
      path: "mfaResetVerification",
      before: null,
      after: input.verification,
    });

    const base = (process.env.NEXT_PUBLIC_APP_URL || "https://markii.shop").replace(/\/+$/, "");
    const support = process.env.CONTACT_TO?.trim() || "support@markii.shop";
    ctx.effect(`email ${notifyTo} that their MFA was reset`, async () => {
      const mail = mfaReset({ orgName: org.name, signInUrl: `${base}/sign-in`, supportAddress: support });
      const sent = await sendPlatformMail({
        to: notifyTo,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: support,
      });
      if (!sent.sent) console.error("[platform] MFA reset notice not sent", sent.reason);
    });

    return {
      userId: member.userId,
      email: member.email,
      factorsRemoved: removal.removed,
      sessionsEnded,
      /**
       * Where the notice is *queued* to. It sends after commit and a failure
       * is only logged, so this names the address — it does not claim delivery.
       */
      noticeTo: notifyTo,
      note: "They will be asked to set up a new authenticator at their next sign-in.",
    };
  },
});
