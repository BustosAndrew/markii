import { NextResponse } from "next/server";
import { badRequest, notFound, unauthorized } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { isAgentKind } from "@/lib/ops-agents";
import { listSessions } from "@/lib/ops-agents/sessions";

/**
 * `GET /api/agents/sessions?agent=&siteId=` — the caller's own agent
 * conversations, newest first, optionally one agent's and one site's (the
 * brand agent's conversations are per storefront). Never anyone else's: a
 * transcript is what one person typed.
 */
export const GET = orgHandler(async (req, { orgId, session }) => {
  if (!session.user) throw unauthorized("Merchant agents are used from the dashboard.");
  const agent = new URL(req.url).searchParams.get("agent");
  if (agent != null && !isAgentKind(agent)) throw notFound("Agent");
  const siteParam = new URL(req.url).searchParams.get("siteId");
  const siteId = siteParam != null && /^\d+$/.test(siteParam) ? Number(siteParam) : undefined;
  if (siteParam != null && siteId === undefined) throw badRequest("siteId must be a number.");
  const rows = await listSessions(
    { orgId, userId: session.user.id },
    { agent: agent ?? undefined, siteId },
  );
  return NextResponse.json({
    items: rows.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
  });
});
