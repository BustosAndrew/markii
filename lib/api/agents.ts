import { apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";
import type { DiffEntry } from "./actions";

const AGENTS_SECTION = "API §27";

/**
 * Merchant agents (§27, D47) — the Catalog agent first, in beta.
 *
 * **The chat itself is not a function here.** `POST /api/agents/:agent/chat`
 * streams an AI SDK UI message stream, which is `useChat`'s job — see
 * {@link agentChatEndpoint} and `docs/FRONTEND.md` for the transport. What this
 * service covers is everything around the stream: the directory, the beta
 * allowance, past sessions, and the decision on each proposal.
 *
 * **A proposal is the only thing a screen can act on, and approving it is the
 * only way an agent's suggestion becomes a change.** Render `diff` — the dry
 * run's real output — on the card, never the model's prose about it.
 */

const AGENTS_API_LIVE = true;

export type AgentKind = "catalog";

export type AgentAllowance = {
  usedTokens: number;
  capTokens: number;
  remainingTokens: number;
  /** False once the month's beta allowance is spent; chat answers `409 QUOTA_EXCEEDED`. */
  allowed: boolean;
  periodStart: string;
  resetsAt: string;
};

export type AgentDirectory = {
  agents: { id: AgentKind; name: string; description: string; beta: true }[];
  /** Markii's deployment can call a model. False → show *configuration required*, not an error. */
  configured: boolean;
  /** This org's month. A separate fact from `configured`; never merge them into one "available". */
  allowance: AgentAllowance;
};

export type AgentProposalStatus =
  | "pending"
  /** An approval is in flight. Treat as pending with the buttons disabled. */
  | "approving"
  | "executed"
  | "rejected"
  | "failed"
  /** The store changed after it was proposed; nothing was applied. Offer "ask again", not "retry". */
  | "stale";

export type AgentProposal = {
  id: string;
  sessionId: string;
  agent: AgentKind;
  /** The registry action approval runs — `catalog.updateProduct`, `inventory.adjust`, … */
  actionId: string;
  input: unknown;
  riskTier: "read" | "low" | "medium" | "high";
  /** The model's one-liner. Label it as the agent's words. */
  summary: string;
  rationale: string | null;
  /** The dry run's field-level diff — what the card shows and what approval writes. */
  diff: DiffEntry[];
  affectedCount: number;
  status: AgentProposalStatus;
  /** Set once executed. Undo is `POST /api/actions/{actionId}/undo` with `{ invocationId }`. */
  invocationId: string | null;
  error: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type AgentSessionSummary = {
  id: string;
  agent: AgentKind;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionDetail = AgentSessionSummary & {
  /** AI SDK `UIMessage[]` — pass straight to `useChat({ messages })`. */
  messages: unknown[];
  proposals: AgentProposal[];
};

export type AgentApproval = {
  proposal: AgentProposal;
  invocation: { id: string; undoable: boolean; diff: DiffEntry[] };
};

/**
 * Where `useChat`'s transport posts. Send `{ sessionId?, message }` — the new
 * message only — and read `x-agent-session-id` off the first response.
 */
export function agentChatEndpoint(agent: AgentKind): string {
  return `/api/agents/${agent}/chat`;
}

export function getAgentDirectory(init?: RequestInit) {
  return callWhenLive(AGENTS_API_LIVE, AGENTS_SECTION, () =>
    apiGet<AgentDirectory>("/api/agents", undefined, init),
  );
}

export function listAgentSessions(init?: RequestInit) {
  return callWhenLive(AGENTS_API_LIVE, AGENTS_SECTION, () =>
    apiGet<{ items: AgentSessionSummary[] }>("/api/agents/sessions", undefined, init),
  );
}

export function getAgentSession(id: string, init?: RequestInit) {
  return callWhenLive(AGENTS_API_LIVE, AGENTS_SECTION, () =>
    apiGet<AgentSessionDetail>(`/api/agents/sessions/${encodeURIComponent(id)}`, undefined, init),
  );
}

/**
 * Apply a proposal. Can answer:
 * - `409` with `details.status === "stale"` — the store changed; nothing applied.
 * - `403 MFA_REQUIRED` — the dashboard's step-up modal handles it; the proposal stays pending.
 * - the action's own refusals (`FORBIDDEN` for a role without `catalog.write`, `TRIAL_ENDED`, …).
 */
export function approveAgentProposal(id: string, init?: RequestInit) {
  return callWhenLive(AGENTS_API_LIVE, AGENTS_SECTION, () =>
    apiPost<AgentApproval>(`/api/agents/proposals/${encodeURIComponent(id)}/approve`, undefined, init),
  );
}

export function rejectAgentProposal(id: string, init?: RequestInit) {
  return callWhenLive(AGENTS_API_LIVE, AGENTS_SECTION, () =>
    apiPost<{ proposal: AgentProposal }>(
      `/api/agents/proposals/${encodeURIComponent(id)}/reject`,
      undefined,
      init,
    ),
  );
}
