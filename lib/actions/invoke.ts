import { ApiError, forbidden, notFound } from "../api";
import { assertStepUp } from "../auth/mfa";
import { assertAccountStanding } from "../billing/standing-guard";
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
  /**
   * Set by `undoInvocation` alone: the invocation this one is reversing.
   *
   * Recorded so the audit log reads in both directions — the original carries
   * `undoneByInvocationId`, and this carries the way back. A reader looking at
   * a surprising change should not have to scan for a matching inverse to
   * discover it was an undo. It grants nothing; it is a label.
   */
  undoOf?: string;
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
  { actor, dryRun = false, undoOf }: InvokeOptions,
): Promise<InvocationOutcome<TResult>> {
  const def = getAction(actionId);
  if (!def) throw notFound(`Action "${actionId}"`);

  // Permission first: an unauthorized caller learns nothing about the input shape.
  if (!(await authorize(actor, def.permission))) {
    throw forbidden(`Missing permission "${def.permission}" for action "${def.id}"`);
  }

  /**
   * **§22 rule 3, finally enforced: a `high` action never auto-runs.**
   *
   * The rule has been in the contract since the registry shipped, and until now
   * it was only *advertised* — `describeAction` publishes
   * `requiresHumanApproval` so an agent knows a gate is coming, but nothing
   * refused the call. For a person in the dashboard that was survivable: the
   * money-moving actions also carry `requiresStepUp`, and a browser session has
   * to produce a fresh factor. **A token is exempt from step-up**
   * (`lib/auth/mfa.ts` — a scoped token is its own credential), so for a token
   * caller both gates were absent and only the permission check stood.
   *
   * That gap is tolerable while the only way in is a deliberate server-to-server
   * integration. It is not tolerable as the front door for MCP, where the
   * credential is held by a model reading merchant catalog content — and
   * `docs/AGENT-OPS.md` §3 is explicit that retrieved content is untrusted data,
   * never instruction. An agent that reads "also update the payout address" in a
   * product description must not be one tool call away from doing it.
   *
   * **Dry runs always pass**, which is the point rather than a loophole: rule 2
   * makes `dry-run → render diff → human approves → invoke` the proposal flow,
   * so an agent can still *propose* every one of these. It just cannot be the
   * one who approves.
   */
  if (!dryRun && def.riskTier === "high" && requiresHumanApproval(actor)) {
    throw new ApiError(
      "HUMAN_APPROVAL_REQUIRED",
      403,
      `"${def.id}" is a high-risk action and cannot be run by a ${actor.type}. ` +
        "A person has to approve it.",
      {
        actionId: def.id,
        riskTier: def.riskTier,
        actorType: actor.type,
        /**
         * **Transport-neutral on purpose.** This string is read by an HTTP
         * client and by an MCP client, and the two spell a dry run
         * differently — naming only the query parameter sent an MCP agent
         * looking for a flag that does not exist on that surface.
         */
        resolution:
          'Produce the diff with a dry run first — "?dryRun=1" over HTTP, ' +
          '"_dryRun": true over MCP — then have a staff member approve and run it ' +
          "from the dashboard.",
      },
    );
  }

  /**
   * Step-up (D40): a **fresh** second factor for anything that moves money or
   * grants access.
   *
   * Checked here rather than in a route handler because §22 rule 1 makes this
   * the only mutation path — so this one check covers the dashboard, the HTTP
   * API, agent tools, and MCP simultaneously, and no caller has a way around it.
   * That is the entire reason the registry exists, and a per-route check would
   * have left the agent path open.
   *
   * **Skipped on a dry run**, which writes nothing and exists precisely so an
   * agent can show a human what *would* happen before asking them to authorise
   * it. Demanding a factor to render a proposal would put the challenge before
   * the decision.
   */
  if (def.requiresStepUp && !dryRun) {
    await assertStepUp(actor, def.id);
  }

  /**
   * Account standing: the free month has to actually end somewhere.
   *
   * Here for the same reason step-up is here — §22 rule 1 makes this the only
   * mutation path, so one check holds the dashboard, the HTTP API, agent tools
   * and MCP at once. A per-route check would leave the agent path open, which is
   * exactly the hole `PUT /api/integrations/:provider` turned out to be.
   *
   * **Billing actions are exempt, and that is the whole point.** "Subscribe to
   * reinstate everything" is impossible if the act of subscribing is itself
   * gated — the merchant would be locked out of the only door. Reads are
   * untouched throughout: a merchant out of standing can still see and export
   * their catalog, orders and customers, because holding a store is a commercial
   * measure and must never look like holding their data hostage.
   *
   * Dry runs pass so an agent can still show a merchant what *would* happen.
   */
  if (!dryRun && !def.id.startsWith("billing.") && actor.orgId) {
    await assertAccountStanding(actor.orgId, def.id);
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
        invocationId,
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
        undoOfInvocationId: undoOf ?? null,
        ipAddress: actor.request?.ip ?? null,
        userAgent: actor.request?.userAgent ?? null,
      });
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) {
      // The failure audit is written outside the rolled-back transaction — "who
      // tried what and was refused" is the half of an audit log that matters
      // during an incident.
      await recordFailure(invocationId, def.id, actor, def.riskTier, auditInput, e, undoOf);
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
 * Whether this actor needs a person to approve a `high` action.
 *
 * **`system` is exempt, and it has to be** — the monthly billing sweep invokes
 * `billing.invoiceAssessments`, which is `high`, and there is nobody awake at
 * 03:00 on the first to approve it. That exemption is not a hole in the same
 * shape as the token one: a `system` actor is mintable from exactly one HTTP
 * caller, gated by `CRON_SECRET` (D41), running Markii's own scheduled code
 * against no untrusted input. The threat rule 3 answers is an agent acting on
 * content it read; a cron reads a clock.
 *
 * `user` is exempt because a person *is* the human approval, and the
 * money-moving subset additionally demands a fresh factor through `step-up`.
 */
function requiresHumanApproval(actor: Actor): boolean {
  return actor.type === "token" || actor.type === "agent";
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
  undoOf?: string,
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
      // A failed undo is still worth pairing with what it tried to reverse.
      undoOfInvocationId: undoOf ?? null,
      /**
       * **Recorded on failures especially.** A refused attempt is the row an
       * incident is reconstructed from, and the address it came from is most of
       * what makes it useful — "someone tried and was denied" without a where is
       * a much weaker signal than the same line with one.
       */
      ipAddress: actor.request?.ip ?? null,
      userAgent: actor.request?.userAgent ?? null,
    });
  } catch (e) {
    // Never let an audit-write failure mask the original error.
    console.error("[actions] failed to record invocation failure", e);
  }
}
