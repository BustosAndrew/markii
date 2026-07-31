import { z } from "zod";
import type { ActionDefinition, Actor, Permission } from "./types";

/**
 * The action registry (`docs/API.md` §22).
 *
 * Every mutating capability is defined here exactly once and becomes the UI
 * mutation, the HTTP endpoint, the agent tool, and the MCP tool simultaneously.
 * The point is not convenience — it is that no caller can obtain a privileged
 * path around validation or permissions, because there is only one path.
 */

const registry = new Map<string, ActionDefinition<never, unknown>>();

export function defineAction<TInput, TResult>(
  def: ActionDefinition<TInput, TResult>,
): ActionDefinition<TInput, TResult> {
  if (registry.has(def.id)) {
    // Two definitions for one id means one silently wins, and which one depends
    // on import order. Fail at module load instead.
    throw new Error(`Duplicate action id "${def.id}"`);
  }
  if (!/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(def.id)) {
    throw new Error(`Action id "${def.id}" must look like "domain.verbNoun"`);
  }
  registry.set(def.id, def as unknown as ActionDefinition<never, unknown>);
  return def;
}

export function getAction(id: string): ActionDefinition<never, unknown> | undefined {
  return registry.get(id);
}

export function allActions(): ActionDefinition<never, unknown>[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Registry entry as `GET /api/actions` returns it — JSON Schema so agents can call it blind. */
export function describeAction(def: ActionDefinition<never, unknown>) {
  return {
    id: def.id,
    description: def.description,
    permission: def.permission,
    riskTier: def.riskTier,
    undoable: def.undoable ?? false,
    /**
     * `high` never auto-runs, whoever asks (§22 rule 3). Stated in the registry
     * so an agent knows before invoking that a human gate is coming.
     */
    requiresHumanApproval: def.riskTier === "high",
    input: z.toJSONSchema(def.input, { io: "input" }),
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Resolves whether an actor holds a permission. Phase A installs the real one
 * (org membership + role). It is injected rather than imported so the registry
 * does not depend on the auth model that does not exist yet — and so tests can
 * substitute one without a session.
 */
export type AuthorizationResolver = (actor: Actor, permission: Permission) => Promise<boolean>;

/**
 * Deny by default. Until Phase A lands there is no way to know who anyone is,
 * and the honest answer to "may this actor do that" is no — not "probably".
 */
const denyAll: AuthorizationResolver = async () => false;

let resolver: AuthorizationResolver = denyAll;

export function setAuthorizationResolver(next: AuthorizationResolver) {
  resolver = next;
}

export function authorize(actor: Actor, permission: Permission): Promise<boolean> {
  return resolver(actor, permission);
}

/** True while no real resolver is installed — the registry is wired but not yet usable. */
export function isAuthorizationConfigured() {
  return resolver !== denyAll;
}
