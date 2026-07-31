import { ApiError, forbidden, notFound } from "../api";
import { actionInvocations, db, type DiffEntry } from "../db";
import { authorize, getAction } from "./registry";
import type { ActionContext, Actor, InvocationOutcome } from "./types";

/** Rolls the transaction back once a dry run has produced its diff. Never escapes. */
class DryRunRollback extends Error {
  constructor() {
    super("dry-run rollback");
  }
}

function newInvocationId() {
  return `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export type InvokeOptions = {
  actor: Actor;
  /** Produce the diff the invocation *would* write, then roll back (§22 rule 2). */
  dryRun?: boolean;
};

/**
 * The single mutation path (`docs/API.md` §22 rule 1).
 *
 * Same validation, same server-checked permission, and same audit record whether
 * the caller is a click, an agent turn, an MCP client, or CI. A route handler
 * that mutates state without coming through here is a bug, not a shortcut.
 *
 * Dry run is the real action inside a transaction that is rolled back, rather
 * than a parallel "what would happen" implementation. A second implementation
 * drifts from the first, and a proposal that does not match its execution is
 * worse than no proposal at all.
 */
export async function invokeAction<TResult = unknown>(
  actionId: string,
  rawInput: unknown,
  { actor, dryRun = false }: InvokeOptions,
): Promise<InvocationOutcome<TResult>> {
  const def = getAction(actionId);
  if (!def) throw notFound(`Action "${actionId}"`);

  // Permission first: an unauthorized caller learns nothing about the input shape.
  if (!(await authorize(actor, def.permission))) {
    throw forbidden(`Missing permission "${def.permission}" for action "${def.id}"`);
  }

  const input = def.input.parse(rawInput) as never;

  const invocationId = newInvocationId();
  const diff: DiffEntry[] = [];
  const effects: { description: string; fn: () => Promise<void> }[] = [];
  let result: TResult | undefined;

  const auditInput = def.redactInput ? def.redactInput(input) : input;

  try {
    await db.transaction(async (tx) => {
      const ctx: ActionContext = {
        actor,
        db: tx,
        dryRun,
        can: (permission) => authorize(actor, permission),
        recordDiff: (entry) => void diff.push(entry),
        effect: (description, fn) => void effects.push({ description, fn }),
      };

      result = (await def.run(input, ctx)) as TResult;

      if (dryRun) throw new DryRunRollback();

      // Inside the transaction: an invocation and its audit record commit
      // together or not at all.
      await tx.insert(actionInvocations).values({
        id: invocationId,
        actionId: def.id,
        actorType: actor.type,
        actorId: actor.id,
        orgId: actor.orgId,
        riskTier: def.riskTier,
        input: auditInput,
        result: (result ?? null) as unknown,
        diff,
        ok: true,
        undoable: def.undoable ?? false,
      });
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) {
      // The failure audit is written outside the rolled-back transaction — "who
      // tried what and was refused" is the half of an audit log that matters
      // during an incident.
      await recordFailure(invocationId, def.id, actor, def.riskTier, auditInput, e);
      throw e;
    }
  }

  if (!dryRun) await flushEffects(invocationId, effects);

  return {
    invocationId,
    ok: true,
    result,
    diff,
    undoable: def.undoable ?? false,
    dryRun,
  };
}

/**
 * Effects run only after the transaction commits, so a rolled-back action never
 * sends an email or charges a card. They cannot fail the invocation — the write
 * is already durable — so a failure is logged loudly rather than thrown.
 */
async function flushEffects(
  invocationId: string,
  effects: { description: string; fn: () => Promise<void> }[],
) {
  for (const effect of effects) {
    try {
      await effect.fn();
    } catch (e) {
      console.error(`[actions] effect "${effect.description}" failed after ${invocationId}`, e);
    }
  }
}

async function recordFailure(
  invocationId: string,
  actionId: string,
  actor: Actor,
  riskTier: "read" | "low" | "medium" | "high",
  input: unknown,
  error: unknown,
) {
  try {
    await db.insert(actionInvocations).values({
      id: invocationId,
      actionId,
      actorType: actor.type,
      actorId: actor.id,
      orgId: actor.orgId,
      riskTier,
      input,
      result: null,
      diff: [],
      ok: false,
      errorCode: error instanceof ApiError ? error.code : "INTERNAL",
      errorMessage: error instanceof Error ? error.message : String(error),
      undoable: false,
    });
  } catch (e) {
    // Never let an audit-write failure mask the original error.
    console.error("[actions] failed to record invocation failure", e);
  }
}
