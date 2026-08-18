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
  /**
   * `undoable` and `inverse` must agree, checked at module load.
   *
   * Before undo was built, `undoable: true` was a hand-set boolean nothing read
   * — and it was wrong on four of the twenty-one actions carrying it, including
   * one whose own PII redaction destroys the values an undo would need. A flag
   * that the registry publishes to agents and stores on every audit row cannot
   * be an unverified claim, so the two are now tied together and neither can be
   * declared alone.
   */
  if (def.undoable === true && typeof def.inverse !== "function") {
    throw new Error(
      `Action "${def.id}" declares undoable: true but defines no inverse(). ` +
        `Add one, or say undoable: false.`,
    );
  }
  if (typeof def.inverse === "function" && def.undoable !== true) {
    throw new Error(`Action "${def.id}" defines inverse() but does not declare undoable: true.`);
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

/**
 * JSON Schema for an action's input.
 *
 * **A `z.date()` has no JSON Schema representation, and zod's default is to
 * throw.** That took the whole of `GET /api/actions` down with a 500 for any
 * caller holding `commerce.write`, because `discounts.create` and
 * `discounts.update` accept `z.coerce.date()` — one unrepresentable field in
 * one action, and the registry listing every agent discovers Markii through
 * answered nothing at all. Found 2026-08-18 by the undo tests, which read
 * `undoable` off this endpoint.
 *
 * A date is expressed as an ISO string here rather than `{}`, which is what
 * `unrepresentable: "any"` alone would produce. `{}` means "anything goes" — an
 * agent reading it would have no idea a date was wanted, which is worse than a
 * loose type: it is a confident wrong answer. The wire format really is a
 * string, since `coerce.date()` is what parses it.
 */
function inputSchemaFor(def: ActionDefinition<never, unknown>) {
  return z.toJSONSchema(def.input, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === "date") {
        ctx.jsonSchema.type = "string";
        ctx.jsonSchema.format = "date-time";
      }
    },
  });
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
     * Advertised so an agent knows before invoking that a human will have to
     * re-authenticate — the same reason `requiresHumanApproval` is published.
     * Discovering it from a refusal is worse than reading it from the registry.
     */
    requiresStepUp: def.requiresStepUp ?? false,
    /**
     * `high` never auto-runs, whoever asks (§22 rule 3). Stated in the registry
     * so an agent knows before invoking that a human gate is coming.
     */
    requiresHumanApproval: def.riskTier === "high",
    input: inputSchemaFor(def),
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
