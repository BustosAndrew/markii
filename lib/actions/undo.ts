import { and, eq, isNull } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../api";
import { actionInvocations, db, type DiffEntry } from "../db";
import { invokeAction } from "./invoke";
import { getAction } from "./registry";
import type { Actor, InvocationOutcome, RecordedInvocation } from "./types";

/**
 * Undo (`POST /api/actions/:id/undo`, `docs/API.md` §22).
 *
 * **An undo is a new forward invocation, not a rollback.** The transaction that
 * made the change committed long ago; the world has moved on, and the only
 * honest way back is to ask the registry to make the opposite change now. That
 * means undo inherits every guarantee the registry already provides — the
 * action's permission is re-checked, step-up is re-demanded, the input is
 * re-validated, and the undo is itself audited and usually itself undoable.
 *
 * Three refusals matter more than the happy path:
 *
 * - **An action with no `inverse` is refused, not approximated.** `undoable` is
 *   tied to `inverse` in `defineAction`, so this cannot be reached by a stale
 *   flag — but a definition may still lose its inverse in a later edit.
 * - **An invocation may be undone once**, decided by a conditional update
 *   rather than by the read above it.
 * - **A changed field is a conflict, not a silent overwrite.** If someone has
 *   edited the row since, restoring the old value would discard their change
 *   without either person seeing it happen.
 */

export type UndoOutcome = InvocationOutcome & {
  /** The invocation this reversed, so a caller can pair them in one response. */
  undoOf: string;
  /** The action that actually ran — often, but not always, the original's. */
  undoneWith: string;
};

/** Reasons a specific invocation cannot be undone, as `details.undo` on the 409. */
type UndoRefusal =
  | "no_inverse"
  | "not_representable"
  | "already_undone"
  | "failed_invocation"
  | "conflict";

function refuse(reason: UndoRefusal, message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError("CONFLICT", 409, message, { undo: reason, ...(details ?? {}) });
}

/**
 * Compare the way the audit table does. A diff written in memory holds `Date`
 * objects and `undefined`; the same diff read back from `jsonb` holds ISO
 * strings and `null`. Comparing them raw reports every timestamp as a conflict.
 */
function jsonish(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonish);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [k, jsonish(v)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(jsonish(a)) === JSON.stringify(jsonish(b));
}

const keyOf = (d: DiffEntry) => `${d.entity}:${d.entityId}:${d.path}`;

/**
 * Refuse when the current value is not what this invocation left behind.
 *
 * The check reads the *inverse's own dry run*, which records a `before` for
 * every field it is about to write — so the current state comes from the same
 * code that will do the writing, rather than from a second reader that could
 * disagree with it. A dry run is the real action in a rolled-back transaction
 * (§22 rule 2), so this costs one transaction and writes nothing.
 *
 * It narrows the window between reading and writing; it does not lock the row.
 * A merchant dashboard is the caller, so a check is proportionate — anything
 * touching money takes the transaction, not this.
 */
async function assertNoConflict(
  recorded: RecordedInvocation,
  inverseActionId: string,
  inverseInput: unknown,
  actor: Actor,
) {
  const preview = await invokeAction(inverseActionId, inverseInput, { actor, dryRun: true });

  const current = new Map(preview.diff.map((d) => [keyOf(d), d.before]));
  const stale = recorded.diff.filter(
    (d) => current.has(keyOf(d)) && !sameValue(current.get(keyOf(d)), d.after),
  );

  if (stale.length > 0) {
    throw refuse(
      "conflict",
      `This has changed since: ${stale.map((d) => d.path).join(", ")}. ` +
        "Undoing now would discard that change.",
      {
        conflicts: stale.map((d) => ({
          entity: d.entity,
          path: d.path,
          expected: jsonish(d.after),
          current: jsonish(current.get(keyOf(d))),
        })),
      },
    );
  }
}

export type UndoOptions = {
  actor: Actor;
  /**
   * The action id from the route path. Checked against the record so a caller
   * cannot undo one invocation while believing they are undoing another.
   */
  expectActionId?: string;
};

export async function undoInvocation(
  invocationId: string,
  { actor, expectActionId }: UndoOptions,
): Promise<UndoOutcome> {
  // Org scope first: a caller must not learn that another tenant's invocation
  // id exists, so a foreign one is a 404 exactly like a missing one.
  if (!actor.orgId) throw notFound("Invocation");

  const [row] = await db
    .select()
    .from(actionInvocations)
    .where(and(eq(actionInvocations.id, invocationId), eq(actionInvocations.orgId, actor.orgId)))
    .limit(1);
  if (!row) throw notFound("Invocation");

  if (expectActionId && expectActionId !== row.actionId) {
    throw badRequest(`Invocation ${invocationId} is "${row.actionId}", not "${expectActionId}".`);
  }

  // A refused invocation rolled back and changed nothing. "Undoing" it would
  // invent a change that never happened.
  if (!row.ok) {
    throw refuse("failed_invocation", "That invocation failed, so there is nothing to undo.");
  }
  if (row.undoneByInvocationId) {
    throw refuse(
      "already_undone",
      `That was already undone by invocation ${row.undoneByInvocationId}.`,
    );
  }

  const def = getAction(row.actionId);
  if (!def) throw notFound(`Action "${row.actionId}"`);
  if (!row.undoable || !def.inverse) {
    throw refuse("no_inverse", `"${row.actionId}" cannot be undone.`);
  }

  const recorded: RecordedInvocation = {
    invocationId: row.id,
    actionId: row.actionId,
    input: row.input,
    result: row.result,
    diff: row.diff,
  };

  const inverse = def.inverse(recorded);
  if (!inverse) {
    throw refuse(
      "not_representable",
      `This particular "${row.actionId}" cannot be reversed — its record does not ` +
        "describe a change that can be expressed as an action.",
    );
  }
  if (!getAction(inverse.actionId)) throw notFound(`Action "${inverse.actionId}"`);

  if ((inverse.conflictCheck ?? "strict") === "strict") {
    await assertNoConflict(recorded, inverse.actionId, inverse.input, actor);
  }

  /**
   * The inverse runs through the front door. Permission, step-up, validation,
   * and the audit record are all `invokeAction`'s, so undo holds no privileges
   * of its own — the same reason §22 rule 1 exists. A merchant who has lost
   * `catalog.write` since cannot undo their way back into the catalog.
   */
  const outcome = await invokeAction(inverse.actionId, inverse.input, {
    actor,
    undoOf: row.id,
  });

  /**
   * Claim the original **conditionally**. Two callers pressing undo at the same
   * moment both pass the read above, and `isNull` here is what decides which
   * one owns it. The loser's inverse has already run, so it is reported rather
   * than hidden — two inverses applied to one change is a state worth seeing in
   * the audit log, and the second one's own record is already there.
   */
  const claimed = await db
    .update(actionInvocations)
    .set({ undoneByInvocationId: outcome.invocationId })
    .where(and(eq(actionInvocations.id, row.id), isNull(actionInvocations.undoneByInvocationId)))
    .returning({ id: actionInvocations.id });

  if (claimed.length === 0) {
    console.warn(
      `[actions] ${row.id} was undone concurrently; ${outcome.invocationId} also applied an inverse`,
    );
  }

  return { ...outcome, undoOf: row.id, undoneWith: inverse.actionId };
}
