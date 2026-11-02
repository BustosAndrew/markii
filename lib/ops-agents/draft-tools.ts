import "server-only";

import { tool, type Tool } from "ai";
import { z } from "zod";
import { getAction, invokeAction } from "../actions";
import { ApiError } from "../api";
import { AGENT_MAX_DRAFT_WRITES_PER_TURN } from "./config";
import { diffForModel } from "./proposal-diff";
import type { TurnContext } from "./propose-tools";

/**
 * Draft tools — the brand agent's edits, which **execute** (D51).
 *
 * Generated from the registry exactly as propose tools are, so a tool's input
 * is the action's own schema and its description the action's own; the
 * difference is that `execute` invokes for real rather than as a dry run.
 * That is only possible for actions flagged `agentExecution: "draft"` —
 * `invokeAction` refuses any other non-dry-run from an agent actor — and this
 * builder refuses to generate a tool for one that is not, so an allowlist
 * edit cannot quietly hand the agent a publish button.
 *
 * **Bound to one site.** `siteId` is removed from the schema the model sees
 * and supplied from the turn, so a turn about one storefront cannot edit
 * another even if the model (or something it read) names a different id.
 *
 * Every write takes the design row's lock and checks the turn still holds the
 * edit lease (`lib/builder/store.ts` `assertMayWrite`): a stopped turn's next
 * call is refused, and the refusal tells the model to stop.
 */

/** `builder.setProps` → `builder_setProps`, the same name the MCP server gives it. */
export function draftToolName(actionId: string): string {
  return actionId.replace(/\./g, "_");
}

export function draftTools(actionIds: readonly string[], turn: TurnContext, siteId: number, onWrite?: () => void) {
  let writes = 0;
  let stopped = false;
  const tools: Record<string, Tool> = {};

  for (const actionId of actionIds) {
    const def = getAction(actionId);
    if (!def) throw new Error(`Agent "${turn.agent}" names unknown action "${actionId}"`);
    if (def.agentExecution !== "draft") {
      throw new Error(`Agent "${turn.agent}" may not execute "${actionId}": it is not a draft-only action`);
    }
    const shape = def.input as unknown as z.ZodObject;
    if (typeof shape.omit !== "function" || !("siteId" in shape.shape)) {
      throw new Error(`Draft action "${actionId}" must take a top-level siteId to be bound to a site`);
    }

    tools[draftToolName(actionId)] = tool({
      description: `${def.description} Edits the unpublished draft immediately; shoppers see nothing until the merchant publishes.`,
      inputSchema: shape.omit({ siteId: true }),
      execute: async (input) => {
        if (stopped) {
          return { status: "stopped" as const, message: "The merchant stopped you. Make no further changes; summarise what you did." };
        }
        if (writes >= AGENT_MAX_DRAFT_WRITES_PER_TURN) {
          return {
            status: "limit_reached" as const,
            message:
              `This turn has already made ${AGENT_MAX_DRAFT_WRITES_PER_TURN} edits, the most one turn may. ` +
              "Stop here, tell the merchant what you changed and what is left, and ask whether to continue.",
          };
        }
        try {
          const outcome = await invokeAction(actionId, { ...(input as object), siteId }, { actor: turn.actor });
          writes += 1;
          onWrite?.();
          return {
            status: "applied" as const,
            invocationId: outcome.invocationId,
            result: outcome.result,
            changes: diffForModel(outcome.diff),
          };
        } catch (e) {
          if (e instanceof ApiError && e.code === "AGENT_EDITING") {
            stopped = true;
            return {
              status: "stopped" as const,
              message: "The merchant stopped you, or this turn timed out. Make no further changes; summarise what you did.",
            };
          }
          // A refusal is a value the model can correct, not an error that ends the turn.
          return {
            status: "refused" as const,
            code: e instanceof ApiError ? e.code : "INTERNAL",
            message: e instanceof ApiError ? e.message : "The edit could not be applied.",
            details: e instanceof ApiError ? e.details : undefined,
          };
        }
      },
    });
  }

  return tools;
}
