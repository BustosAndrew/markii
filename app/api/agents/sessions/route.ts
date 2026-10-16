import { NextResponse } from "next/server";
import { unauthorized } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { listSessions } from "@/lib/ops-agents/sessions";

/**
 * `GET /api/agents/sessions` — the caller's own agent conversations, newest
 * first. Never anyone else's: a transcript is what one person typed.
 */
export const GET = orgHandler(async (_req, { orgId, session }) => {
  if (!session.user) throw unauthorized("Merchant agents are used from the dashboard.");
  const rows = await listSessions({ orgId, userId: session.user.id });
  return NextResponse.json({
    items: rows.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
  });
});
