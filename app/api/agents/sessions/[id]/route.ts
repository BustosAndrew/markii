import { NextResponse } from "next/server";
import { unauthorized } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { proposalsForSession, serializeProposal } from "@/lib/ops-agents/proposals";
import { ownedSession } from "@/lib/ops-agents/sessions";

/**
 * `GET /api/agents/sessions/:id` — one conversation: its messages (AI SDK
 * `UIMessage[]`, ready for `useChat`'s `messages`) and its proposals with
 * their current status. Another person's session is a `404`.
 */
export const GET = orgHandler(async (_req, { params, orgId, session }) => {
  if (!session.user) throw unauthorized("Merchant agents are used from the dashboard.");
  const { id } = await params;
  const row = await ownedSession(id, { orgId, userId: session.user.id });
  const proposals = await proposalsForSession(row.id);

  return NextResponse.json({
    id: row.id,
    agent: row.agent,
    title: row.title,
    messages: row.messages,
    proposals: proposals.map((p) => serializeProposal(p)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
});
