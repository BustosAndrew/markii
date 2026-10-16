import { NextResponse } from "next/server";
import { unauthorized } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { approveProposal } from "@/lib/ops-agents/proposals";

/**
 * `POST /api/agents/proposals/:id/approve` — apply what the agent proposed.
 *
 * The only door from a proposal to a write, and it opens only for the
 * signed-in person who owns the session. It re-runs the dry run as them,
 * refuses `409` with `details.status: "stale"` if the store changed since,
 * then invokes the action **as them** — their permission, step-up, and name on
 * the audit row. The reply carries the invocation id: undo is
 * `POST /api/actions/{actionId}/undo` with `{ invocationId }`.
 *
 * No `permission` here on purpose: the action's own permission is checked by
 * `invokeAction`, which knows which action this is.
 */
export const POST = orgHandler(async (_req, { params, session }) => {
  if (!session.user) throw unauthorized("Agent proposals are approved by a signed-in person.");
  const { id } = await params;
  return NextResponse.json(await approveProposal(id, session));
});
