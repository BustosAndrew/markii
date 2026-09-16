import { eq } from "drizzle-orm";
import { z } from "zod";
import { conflict, forbidden, notFound } from "../../api";
import { organizations } from "../../db";
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
