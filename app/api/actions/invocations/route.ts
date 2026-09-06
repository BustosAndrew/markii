import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { actionInvocations, db } from "@/lib/db";

/**
 * `GET /api/actions/invocations` — the audit trail (§22 rule 5): actor, input,
 * result, `occurredAt`.
 *
 * Also backs `/api/org/audit` (§16) — same underlying records, so there is one
 * history rather than two that can disagree.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);

    const conds = [eq(actionInvocations.orgId, orgId)];
    const actionId = sp.get("actionId");
    if (actionId) conds.push(eq(actionInvocations.actionId, actionId));

    const rows = await db
      .select()
      .from(actionInvocations)
      .where(and(...conds))
      .orderBy(desc(actionInvocations.occurredAt))
      .limit(limit)
      .offset(offset);

    return NextResponse.json({
      items: rows.map((r) => ({
        invocationId: r.id,
        actionId: r.actionId,
        actor: { type: r.actorType, id: r.actorId },
        riskTier: r.riskTier,
        ok: r.ok,
        input: r.input,
        result: r.result,
        diff: r.diff,
        error: r.ok ? null : { code: r.errorCode, message: r.errorMessage },
        undoable: r.undoable,
        // Both directions of the undo link, so a screen listing history never
        // has to query again to know a change was reversed — or *is* a reversal.
        undoneBy: r.undoneByInvocationId,
        undoOf: r.undoOfInvocationId,
        occurredAt: r.occurredAt.toISOString(),
      })),
      page,
      limit,
    });
  },
  /**
   * **`org.audit`, and it must stay the same gate `/api/org/audit` uses.**
   *
   * This was `org.read`, which is in `READ_ONLY` — so every role including
   * `viewer` could read the org's whole change history, with each invocation's
   * validated input. Tightening only the §16 route would have left this one as
   * the way around it: two endpoints over one table cannot hold two different
   * permissions, or the looser one is the real permission.
   */
  { permission: "org.audit" },
);
