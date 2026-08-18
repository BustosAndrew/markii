import { apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";

const ACTIONS_SECTION = "API §22";

/** Registry, invoke, the audit trail, and undo are live; the MCP server is not (§22). */
const ACTIONS_API_LIVE = true;
const ACTIONS_UNDO_API_LIVE = true;

export type RiskTier = "read" | "low" | "medium" | "high";

export type ActionDescriptor = {
  id: string;
  description: string;
  permission: string;
  riskTier: RiskTier;
  undoable: boolean;
  /** `high` never auto-runs, whoever asks (§22 rule 3). */
  requiresHumanApproval: boolean;
  /** JSON Schema, so a caller can render or validate an action it has never seen. */
  input: Record<string, unknown>;
};

export type DiffEntry = {
  entity: string;
  entityId: string;
  path: string;
  before: unknown;
  after: unknown;
};

export type ActionOutcome<TResult = unknown> = {
  invocationId: string;
  ok: boolean;
  result?: TResult;
  diff: DiffEntry[];
  undoable: boolean;
  /** True when nothing was written — the diff is a preview, not a record. */
  dryRun: boolean;
};

export function listActions(init?: RequestInit) {
  return callWhenLive(ACTIONS_API_LIVE, ACTIONS_SECTION, () =>
    apiGet<{ items: ActionDescriptor[]; total: number }>("/api/actions", undefined, init),
  );
}

/**
 * Invoke an action — **the only mutation path** (§22 rule 1).
 *
 * A screen never POSTs to a bespoke mutation route, because the registry is what
 * makes a click, an agent turn, and an MCP call go through the same validation,
 * the same server-checked permission, and the same audit row.
 */
export function invokeAction<TResult = unknown>(
  id: string,
  input?: unknown,
  init?: RequestInit,
) {
  return callWhenLive(ACTIONS_API_LIVE, ACTIONS_SECTION, () =>
    apiPost<ActionOutcome<TResult>>(`/api/actions/${id}`, input ?? {}, init),
  );
}

/**
 * The diff an invocation *would* produce, without writing.
 *
 * This is how a confirmation step shows real consequences instead of a guess:
 * the server runs the actual action in a transaction and rolls it back, so what
 * is previewed is what executes (§22 rule 2).
 */
export function dryRunAction<TResult = unknown>(
  id: string,
  input?: unknown,
  init?: RequestInit,
) {
  return callWhenLive(ACTIONS_API_LIVE, ACTIONS_SECTION, () =>
    apiPost<ActionOutcome<TResult>>(`/api/actions/${id}?dryRun=1`, input ?? {}, init),
  );
}

export type ActionInvocation = {
  invocationId: string;
  actionId: string;
  actor: { type: "user" | "agent" | "token" | "system"; id: string };
  riskTier: RiskTier;
  ok: boolean;
  input: unknown;
  result: unknown;
  diff: DiffEntry[];
  /** Refused and failed attempts are audited too, so this is populated when `ok` is false. */
  error: { code: string | null; message: string | null } | null;
  undoable: boolean;
  /** Set once this has been undone — the invocation that reversed it. */
  undoneBy: string | null;
  /** Set when this *is* an undo. Both directions, so a list needs no second query. */
  undoOf: string | null;
  occurredAt: string;
};

/** The audit trail (§22 rule 5). No `total` — the route paginates without counting. */
export function listInvocations(
  query?: { actionId?: string; page?: number; limit?: number },
  init?: RequestInit,
) {
  return callWhenLive(ACTIONS_API_LIVE, ACTIONS_SECTION, () =>
    apiGet<{ items: ActionInvocation[]; page: number; limit: number }>(
      "/api/actions/invocations",
      query,
      init,
    ),
  );
}

export type UndoOutcome = ActionOutcome & {
  /** The invocation that was reversed. */
  undoOf: string;
  /**
   * The action that ran. Often the original's — restoring a price is another
   * price edit — but not always: undoing `email.suppressAddress` runs
   * `email.unsuppressAddress`. Show this, not the id you passed in.
   */
  undoneWith: string;
};

/**
 * Undo a past invocation (§22).
 *
 * `id` is the action the invocation **was**; the server refuses if it does not
 * match the record. Only invocations whose `undoable` is true can be undone,
 * and that flag is derived from the action's own inverse rather than declared,
 * so it can be trusted to gate the button.
 *
 * **Four refusals are all `409` and are distinguished by `error.details.undo`**
 * — `already_undone`, `no_inverse`, `not_representable`, `failed_invocation`,
 * and `conflict`. Only the last is worth a retry, and not until the user has
 * seen `error.details.conflicts`: it means somebody changed the same field
 * since, and undoing would discard their edit. Render that as a question, never
 * as a failure to retry silently.
 *
 * The inverse is a real invocation, so it re-checks permission and can raise
 * `403 MFA_REQUIRED` exactly like the original did — `MfaStepUpProvider`
 * already handles that.
 */
export function undoInvocation(id: string, invocationId: string, init?: RequestInit) {
  return callWhenLive(ACTIONS_UNDO_API_LIVE, ACTIONS_SECTION, () =>
    apiPost<UndoOutcome>(`/api/actions/${id}/undo`, { invocationId }, init),
  );
}
