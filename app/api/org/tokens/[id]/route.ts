import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { apiTokens, db } from "@/lib/db";

/** `DELETE /api/org/tokens/:id` — revoke (§16). */
export const DELETE = orgHandler(
  async (_req, { params, orgId }) => {
    const { id } = await params;

    const [row] = await db
      .update(apiTokens)
      /**
       * Soft revoke. The row stays so past audit entries remain attributable to
       * a named token rather than a dangling id — deleting it would quietly
       * rewrite history. `requireAuthContext` filters on `revokedAt IS NULL`, so
       * the credential stops working immediately.
       */
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.orgId, orgId), isNull(apiTokens.revokedAt)))
      .returning();

    // 404 for another org's token, and for one already revoked.
    if (!row) throw notFound("Token");

    return NextResponse.json({ deleted: true, id });
  },
  { permission: "tokens.manage" },
);
