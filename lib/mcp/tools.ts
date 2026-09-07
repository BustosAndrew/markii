import type { ActionDefinition } from "../actions/types";

/**
 * Mapping the action registry onto MCP tools (`docs/API.md` §22,
 * `docs/BUILDER.md` §10).
 *
 * **The registry is the source; this file only translates.** An action is
 * defined once and becomes a UI mutation, an HTTP endpoint and an MCP tool
 * simultaneously — so nothing here may add a capability, relax a permission, or
 * describe an action differently from how `describeAction` does. If MCP needs
 * something the registry cannot express, the registry is what should change.
 *
 * Kept apart from the route so the translation is testable without HTTP, the
 * same split as `standing` against `standing-guard`.
 */

/** What MCP protocol revision this server speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Protocol versions we will accept from a client during `initialize`.
 *
 * Listed rather than range-checked because the negotiation rule is "echo back a
 * version you support"; guessing at an unknown future revision would claim a
 * compatibility nobody has tested.
 */
const SUPPORTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

/**
 * Action ids carry dots (`catalog.updateVariant`); MCP tool names are widely
 * constrained to `[A-Za-z0-9_-]`, and several clients reject a dot outright.
 *
 * The substitution is reversible because **no action id contains an
 * underscore** — asserted by a test, not assumed, since the day one does this
 * mapping silently starts routing two ids to one tool.
 */
export function toolNameFor(actionId: string): string {
  return actionId.replace(/\./g, "_");
}

export function actionIdFor(toolName: string): string {
  return toolName.replace(/_/g, ".");
}

/**
 * The reserved argument that turns a call into a proposal.
 *
 * Underscore-prefixed so it cannot collide with an action's own field — every
 * action input is a zod object with `camelCase` keys, and `.strict()` on many
 * of them would reject an unexpected property anyway, which is why this is
 * stripped before the input reaches `invokeAction`.
 */
export const DRY_RUN_ARG = "_dryRun";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
};

type Described = ReturnType<typeof import("../actions/registry").describeAction>;

/**
 * One described action → one MCP tool.
 *
 * The description is deliberately augmented rather than replaced. An agent
 * choosing a tool reads only this string, and two facts change what it should
 * do — that a high-risk action will be refused unless dry-run, and that a
 * money-moving one needs a fresh second factor from a human. Both are already
 * published in the registry; leaving them out of the text means the agent finds
 * out by failing.
 */
export function toolFor(described: Described): McpTool {
  const notes: string[] = [];
  if (described.requiresHumanApproval) {
    notes.push(
      `Risk tier: high. A person must approve this — calling it as an agent or token is ` +
        `refused. Pass "${DRY_RUN_ARG}": true to produce the diff for a human to approve.`,
    );
  }
  if (described.requiresStepUp) {
    notes.push("Requires a human to have re-authenticated within the last 15 minutes.");
  }
  if (described.undoable) notes.push("Undoable.");

  return {
    name: toolNameFor(described.id),
    description: [described.description, ...notes].join(" "),
    inputSchema: withDryRun(described.input as Record<string, unknown>),
    annotations: {
      title: described.id,
      /**
       * **Every registry action is a mutation** — §22 rule 1 makes the registry
       * the mutation path, and reads stay on plain REST routes. So this is
       * `false` for all of them today rather than derived from the tier, and it
       * stops being a constant only when read actions exist.
       */
      readOnlyHint: false,
      destructiveHint: described.riskTier === "high",
      idempotentHint: false,
    },
  };
}

/**
 * Adds the dry-run flag to a tool's advertised schema.
 *
 * Injected here rather than in each action's own zod schema, because `dryRun`
 * is a property of *how* an action is invoked, not of what it takes — it is a
 * query flag on the HTTP route for exactly the same reason.
 */
function withDryRun(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  properties[DRY_RUN_ARG] = {
    type: "boolean",
    description:
      "Produce the diff this call would write, and write nothing. Required for high-risk " +
      "actions, which refuse to run unattended.",
  };
  return { ...schema, type: "object", properties };
}

/** Splits the reserved flag off the arguments an action actually validates. */
export function splitDryRun(args: unknown): { dryRun: boolean; input: unknown } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { dryRun: false, input: args ?? {} };
  }
  const { [DRY_RUN_ARG]: flag, ...rest } = args as Record<string, unknown>;
  return { dryRun: flag === true, input: rest };
}

/**
 * The tools a caller may see.
 *
 * **Filtered by the same permission check that would refuse the call**, so the
 * listing never advertises something the caller cannot use — `GET /api/actions`
 * behaves the same way. High-risk actions stay listed for actors that cannot
 * run them, because they *can* still dry-run them, and the description says so.
 */
export async function visibleTools(
  actions: ActionDefinition<never, unknown>[],
  describe: (def: ActionDefinition<never, unknown>) => Described,
  can: (permission: string) => Promise<boolean>,
): Promise<McpTool[]> {
  const out: McpTool[] = [];
  for (const def of actions) {
    if (!(await can(def.permission))) continue;
    out.push(toolFor(describe(def)));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
