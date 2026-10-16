import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { invokeAction } from "../actions";
import { ApiError, conflict, notFound } from "../api";
import type { AuthContext } from "../auth/session";
import {
  agentProposals,
  agentSessions,
  db,
  type AgentKind,
  type AgentProposal,
  type DiffEntry,
} from "../db";
import { affectedCount, sameDiff } from "./proposal-diff";

/**
 * Agent proposals (D47) — a stored dry run waiting for a person.
 *
 * The agent creates these and can do nothing else to them. Approval, the only
 * path to a write, runs as the **approving person** through `invokeAction`, so
 * their permission, their step-up and their name are what the audit row holds.
 */

function newProposalId() {
  return `ap_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function createProposal(input: {
  sessionId: string;
  orgId: string;
  agent: AgentKind;
  actionId: string;
  actionInput: unknown;
  diff: DiffEntry[];
  riskTier: AgentProposal["riskTier"];
  summary: string;
  rationale: string | null;
}): Promise<AgentProposal> {
  const [row] = await db
    .insert(agentProposals)
    .values({
      id: newProposalId(),
      sessionId: input.sessionId,
      orgId: input.orgId,
      agent: input.agent,
      actionId: input.actionId,
      input: input.actionInput,
      diff: input.diff,
      riskTier: input.riskTier,
      summary: input.summary,
      rationale: input.rationale,
      affectedCount: affectedCount(input.diff),
    })
    .returning();
  return row;
}

export function serializeProposal(p: AgentProposal) {
  return {
    id: p.id,
    sessionId: p.sessionId,
    agent: p.agent,
    actionId: p.actionId,
    input: p.input,
    riskTier: p.riskTier,
    summary: p.summary,
    rationale: p.rationale,
    diff: p.diff,
    affectedCount: p.affectedCount,
    status: p.status,
    /**
     * The audit row approval produced. Undo is `POST /api/actions/{actionId}/undo`
     * with `{ invocationId }` — the receipt's Undo button needs both.
     */
    invocationId: p.invocationId,
    error: p.error,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function proposalsForSession(sessionId: string): Promise<AgentProposal[]> {
  return db
    .select()
    .from(agentProposals)
    .where(eq(agentProposals.sessionId, sessionId))
    .orderBy(asc(agentProposals.createdAt));
}

/**
 * A proposal, if it belongs to a session this person owns.
 *
 * Owner-only in the beta: the person who asked the agent is the person who
 * decides. Anyone else gets the `404` an unknown id gets.
 */
async function ownedProposal(id: string, owner: { orgId: string; userId: string }) {
  const [row] = await db
    .select({ proposal: agentProposals })
    .from(agentProposals)
    .innerJoin(agentSessions, eq(agentSessions.id, agentProposals.sessionId))
    .where(
      and(
        eq(agentProposals.id, id),
        eq(agentProposals.orgId, owner.orgId),
        eq(agentSessions.userId, owner.userId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Proposal");
  return row.proposal;
}

/**
 * Refusals that leave the proposal **pending**, because the merchant can fix
 * them and approve again: a second factor, a plan, a card. Anything else is a
 * real failure of this change and is recorded as one.
 */
const RETRYABLE = new Set(["MFA_REQUIRED", "TRIAL_ENDED", "PAYMENT_PAST_DUE", "RATE_LIMITED"]);

function ownerOf(auth: AuthContext) {
  if (!auth.user) {
    // Routes refuse tokens before this; asserted again because the owner check
    // below is meaningless without a person.
    throw new ApiError("UNAUTHORIZED", 401, "Agent proposals are decided by a signed-in person.");
  }
  return { orgId: auth.org.id, userId: auth.user.id };
}

export async function approveProposal(id: string, auth: AuthContext) {
  const owner = ownerOf(auth);
  const proposal = await ownedProposal(id, owner);
  if (proposal.status !== "pending") {
    throw conflict(`This proposal is already ${proposal.status}.`);
  }

  // Claim it, so a second click — or a second tab — cannot execute it twice.
  const [claimed] = await db
    .update(agentProposals)
    .set({ status: "approving" })
    .where(and(eq(agentProposals.id, id), eq(agentProposals.status, "pending")))
    .returning();
  if (!claimed) throw conflict("This proposal is already being decided.");

  const settle = (patch: Partial<typeof agentProposals.$inferInsert>) =>
    db
      .update(agentProposals)
      .set(patch)
      .where(eq(agentProposals.id, id))
      .returning()
      .then(([row]) => row);

  let fresh: DiffEntry[];
  try {
    /**
     * The same input, dry-run again **as the approver**. Their permission is
     * checked here first, and the diff is what this exact invocation would
     * write right now.
     */
    fresh = (await invokeAction(proposal.actionId, proposal.input, { actor: auth.actor, dryRun: true }))
      .diff;
  } catch (e) {
    await settleRefusal(e);
    throw e;
  }

  if (!sameDiff(fresh, proposal.diff)) {
    await settle({ status: "stale", decidedByUserId: owner.userId, decidedAt: new Date() });
    throw new ApiError(
      "CONFLICT",
      409,
      "The store changed after this was proposed, so the change shown is no longer the change " +
        "that would be made. Nothing was applied. Ask the agent to propose it again.",
      { proposalId: id, status: "stale", proposed: proposal.diff, current: fresh },
    );
  }

  try {
    const outcome = await invokeAction(proposal.actionId, proposal.input, { actor: auth.actor });
    const row = await settle({
      status: "executed",
      invocationId: outcome.invocationId,
      decidedByUserId: owner.userId,
      decidedAt: new Date(),
      error: null,
    });
    return {
      proposal: serializeProposal(row),
      invocation: {
        id: outcome.invocationId,
        undoable: outcome.undoable,
        diff: outcome.diff,
      },
    };
  } catch (e) {
    await settleRefusal(e);
    throw e;
  }

  async function settleRefusal(e: unknown) {
    if (e instanceof ApiError && RETRYABLE.has(e.code)) {
      await settle({ status: "pending" });
      return;
    }
    await settle({
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      decidedByUserId: owner.userId,
      decidedAt: new Date(),
    });
  }
}

export async function rejectProposal(id: string, auth: AuthContext) {
  const owner = ownerOf(auth);
  await ownedProposal(id, owner);
  const [row] = await db
    .update(agentProposals)
    .set({ status: "rejected", decidedByUserId: owner.userId, decidedAt: new Date() })
    .where(and(eq(agentProposals.id, id), eq(agentProposals.status, "pending")))
    .returning();
  if (!row) throw conflict("Only a pending proposal can be rejected.");
  return serializeProposal(row);
}
