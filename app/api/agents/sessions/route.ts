import { NextResponse } from "next/server";
import { notFound, unauthorized } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { isAgentKind } from "@/lib/ops-agents";
import { listSessions } from "@/lib/ops-agents/sessions";

/**
 * `GET /api/agents/sessions?agent=` — the caller's own agent conversations,
 * newest first, optionally one agent's. Never anyone else's: a transcript is
 * what one person typed.
 */
export const GET = orgHandler(async (req, { orgId, session }) => {
  if (!session.user) throw unauthorized("Merchant agents are used from the dashboard.");
  const agent = new URL(req.url).searchParams.get("agent");
  if (agent != null && !isAgentKind(agent)) throw notFound("Agent");
  const rows = await listSessions(
    { orgId, userId: session.user.id },
    { agent: agent ?? undefined },
  );
  return NextResponse.json({
    items: rows.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
  });
});
