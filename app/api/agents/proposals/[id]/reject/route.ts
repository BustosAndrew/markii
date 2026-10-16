import { NextResponse } from "next/server";
import { unauthorized } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { rejectProposal } from "@/lib/ops-agents/proposals";

/** `POST /api/agents/proposals/:id/reject` — decline a pending proposal. Nothing is written. */
export const POST = orgHandler(async (_req, { params, session }) => {
  if (!session.user) throw unauthorized("Agent proposals are decided by a signed-in person.");
  const { id } = await params;
  return NextResponse.json({ proposal: await rejectProposal(id, session) });
});
