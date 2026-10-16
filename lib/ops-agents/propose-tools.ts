import "server-only";

import { tool, type Tool } from "ai";
import { z } from "zod";
import { getAction, invokeAction } from "../actions";
import { ApiError } from "../api";
import type { Actor } from "../actions/types";
import type { AgentKind } from "../db";
import { AGENT_MAX_PROPOSALS_PER_TURN } from "./config";
import { createProposal } from "./proposals";
import { diffForModel, proposeToolName } from "./proposal-diff";

/**
 * Propose tools — one per registry action an agent may suggest (D47).
 *
 * **Generated from the registry, not written beside it.** Each tool's input is
 * the action's own zod schema, its description is the action's own
 * description, and its "execution" is `invokeAction` with `dryRun: true`. So
 * the agent's tools *are* the actions, as `docs/AGENT-OPS.md` §2 requires:
 * there is no second copy of a validation rule to drift, and a field added to
 * an action reaches the agent without anyone remembering to add it here.
 *
 * **A propose tool cannot write.** Its only effect is a row in
 * `agent_proposals`; the dry run is rolled back inside `invokeAction`. Nothing
 * the model reads — however it is phrased — can turn a proposal into an
 * execution, because execution is a different endpoint that only a signed-in
 * person can call.
 */

export type TurnContext = {
  agent: AgentKind;
  orgId: string;
  userId: string;
  sessionId: string;
  /** The agent acting on the person's behalf: their role decides what it may propose. */
  actor: Actor;
};

/** What every propose tool takes: the action's input, plus the card's words. */
function proposeSchema(actionInput: z.ZodType) {
  return z.object({
    input: actionInput.describe("The action's input, exactly as the action defines it."),
    summary: z
      .string()
      .min(1)
      .max(200)
      .describe("One line the merchant reads on the approval card: what will change."),
    rationale: z
      .string()
      .max(1000)
      .optional()
      .describe("Why, grounded in the store data you read. Omit rather than speculate."),
  });
}

export function proposeTools(actionIds: readonly string[], turn: TurnContext) {
  let created = 0;
  const tools: Record<string, Tool> = {};

  for (const actionId of actionIds) {
    const def = getAction(actionId);
    // An allowlist naming an action that does not exist is a build error, not
    // a tool that silently vanishes.
    if (!def) throw new Error(`Agent "${turn.agent}" names unknown action "${actionId}"`);

    tools[proposeToolName(actionId)] = tool({
      description:
        `Propose this change for the merchant to approve: ${def.description} ` +
        `Nothing changes until the merchant approves it. Risk tier: ${def.riskTier}.`,
      inputSchema: proposeSchema(def.input as z.ZodType),
      execute: async ({ input, summary, rationale }) => {
        if (created >= AGENT_MAX_PROPOSALS_PER_TURN) {
          return {
            status: "limit_reached" as const,
            message:
              `This turn has already created ${AGENT_MAX_PROPOSALS_PER_TURN} proposals, the ` +
              "most one turn may. Tell the merchant how many remain and ask whether to continue.",
          };
        }

        try {
          const outcome = await invokeAction(actionId, input, { actor: turn.actor, dryRun: true });
          if (outcome.diff.length === 0) {
            return {
              status: "no_change" as const,
              message: "This would change nothing — the values are already as proposed. No proposal was created.",
            };
          }

          const proposal = await createProposal({
            sessionId: turn.sessionId,
            orgId: turn.orgId,
            agent: turn.agent,
            actionId,
            actionInput: input,
            diff: outcome.diff,
            riskTier: def.riskTier,
            summary,
            rationale: rationale ?? null,
          });
          created += 1;

          return {
            status: "proposed" as const,
            proposalId: proposal.id,
            affectedCount: proposal.affectedCount,
            changes: diffForModel(outcome.diff),
            note: "Not applied. The merchant approves or rejects this on its card.",
          };
        } catch (e) {
          /**
           * A refusal is a value the model can explain, not a thrown error
           * that ends the turn — the same reason MCP returns an action's
           * refusal as a tool error rather than a protocol error.
           */
          return {
            status: "refused" as const,
            code: e instanceof ApiError ? e.code : "INTERNAL",
            message: e instanceof ApiError ? e.message : "The change could not be prepared.",
            details: e instanceof ApiError ? e.details : undefined,
          };
        }
      },
    });
  }

  return tools;
}
