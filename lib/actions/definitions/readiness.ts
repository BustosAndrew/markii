import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { badRequest, notFound } from "../../api";
import { readinessIssueStates, staff } from "../../db";
import { defineAction } from "../registry";

/**
 * Readiness issue triage (§9).
 *
 * The only mutable thing about readiness is **what the merchant decided**.
 * Issues themselves are recomputed from the catalog on every request
 * (`lib/readiness/compute.ts`), so there is nothing else here to change: fixing
 * an issue means editing the product, and the issue then stops existing on its
 * own.
 *
 * That is also why `resolve` is not the same as fixing. It records "I have
 * handled this outside the rule's view" — a description the rule cannot see is
 * good enough, say — and the issue stops counting against the score. It does
 * **not** claim the underlying data changed.
 */

export const updateReadinessIssues = defineAction({
  id: "readiness.updateIssues",
  description:
    "Resolve, dismiss, reopen, or assign readiness issues. Dismissing hides an issue and stops " +
    "it counting against the score; it does not change the product. Fixing the product makes the " +
    "issue disappear on its own, with no action needed.",
  input: z
    .object({
      ids: z.array(z.string().min(1).max(64)).min(1).max(500),
      action: z.enum(["resolve", "dismiss", "assign", "reopen"]),
      /** Required for `assign` — a staff user id in this organization. */
      assignee: z.string().min(1).max(128).optional(),
      /** Why. Worth recording for a dismissal someone will question later. */
      note: z.string().max(1000).optional(),
    })
    .strict(),
  permission: "catalog.write",
  /**
   * Low risk on purpose: nothing about the catalog changes, and every decision
   * here is reversible with `reopen`. What it affects is a number on a
   * dashboard, not a shopper or a payment.
   */
  riskTier: "low",
  /**
   * **Not undoable, for two independent reasons.** The diff records
   * `before: null` for every issue — the prior status is not kept — and the
   * input carries one `action` for up to 500 ids, so even with it there is no
   * single invocation that could restore issues which were in different states.
   * `reopen` is the merchant-facing way back and is what the description points
   * at; it is a decision, not a restore.
   */
  undoable: false,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;

    if (input.action === "assign") {
      if (!input.assignee) throw badRequest('action "assign" needs an assignee');
      /**
       * The assignee must be staff in **this** org. Without the check, an issue
       * could be assigned to a user id from another tenant, which both leaks
       * that the id exists and puts a name on a screen that nobody can act on.
       */
      const [member] = await ctx.db
        .select({ userId: staff.userId })
        .from(staff)
        .where(and(eq(staff.orgId, orgId), eq(staff.userId, input.assignee)))
        .limit(1);
      if (!member) throw badRequest("That user is not a member of this organization");
    }

    const status =
      input.action === "resolve"
        ? ("resolved" as const)
        : input.action === "dismiss"
          ? ("dismissed" as const)
          : input.action === "assign"
            ? ("assigned" as const)
            : ("open" as const);

    const now = new Date();
    const rows = input.ids.map((issueId) => ({
      orgId,
      issueId,
      status,
      // Reopening clears the assignee: an issue back in the queue is nobody's
      // until someone takes it.
      assignedTo: input.action === "assign" ? (input.assignee as string) : null,
      note: input.note ?? null,
      actorId: ctx.actor.id,
      updatedAt: now,
    }));

    /**
     * Upsert rather than insert. A state row may not exist yet — issues are not
     * stored, so the first decision about one creates its row — and a merchant
     * changing their mind must not hit a unique-key error.
     *
     * **Ids are not validated against the current issue set on purpose.** A
     * merchant can dismiss something that is about to reappear, and an id whose
     * issue no longer exists is simply inert: the row sits there costing
     * nothing, and means the right thing if the problem ever comes back.
     */
    const written = await ctx.db
      .insert(readinessIssueStates)
      .values(rows)
      .onConflictDoUpdate({
        target: [readinessIssueStates.orgId, readinessIssueStates.issueId],
        set: {
          status,
          assignedTo: input.action === "assign" ? (input.assignee as string) : null,
          note: input.note ?? null,
          actorId: ctx.actor.id,
          updatedAt: now,
        },
      })
      .returning({ issueId: readinessIssueStates.issueId });

    for (const id of input.ids) {
      ctx.recordDiff({
        entity: "readinessIssue",
        entityId: id,
        path: "status",
        before: null,
        after: status,
      });
    }

    return {
      updated: written.length,
      status,
      issueIds: written.map((w) => w.issueId),
      /**
       * Stated plainly so no surface can imply a fix happened: this changed how
       * the issue is tracked, not the catalog it was raised against.
       */
      catalogChanged: false,
    };
  },
});
