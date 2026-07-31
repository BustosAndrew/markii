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
        occurredAt: r.occurredAt.toISOString(),
      })),
      page,
      limit,
    });
  },
  // Reading who changed what is an org-administration concern, not a catalog one.
  { permission: "org.read" },
);
