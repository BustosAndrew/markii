import { apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";

const ACTIONS_SECTION = "API §22";

/** Registry, invoke, and the audit trail are live; undo and MCP are not (§22). */
const ACTIONS_API_LIVE = true;
const ACTIONS_UNDO_API_LIVE = false;

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

/** Planned — actions record an inverse, but no endpoint applies it yet (§22). */
export function undoInvocation(id: string, invocationId: string, init?: RequestInit) {
  return callWhenLive(ACTIONS_UNDO_API_LIVE, ACTIONS_SECTION, () =>
    apiPost<ActionOutcome>(`/api/actions/${id}/undo`, { invocationId }, init),
  );
}
