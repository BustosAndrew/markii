import { limitFromEnv, type RateLimitPolicy } from "../rate-limit";

/**
 * Merchant agents (D47, `docs/AGENT-OPS.md`) — configuration and the beta cap.
 *
 * Pure: nothing here touches the database, so the numbers are testable. The
 * ledger that the cap is measured against is `./usage`.
 */

/**
 * Model ids, through the Vercel AI Gateway as `provider/model` strings — the
 * model is configuration, never a code dependency (`docs/AGENT-OPS.md` §2).
 *
 * Sonnet rather than Opus by default: the catalog agent reads compact tool
 * output and proposes field edits, and the beta's cost ceiling is per org.
 */
export const AGENT_MODELS = {
  catalog: process.env.CATALOG_AGENT_MODEL?.trim() || "anthropic/claude-sonnet-5.5",
  /**
   * The assistant reads short help topics and a checklist and writes a few
   * sentences; it shares the org's beta allowance with the Catalog agent, so a
   * cheaper model is a configuration change away.
   */
  assistant: process.env.ASSISTANT_AGENT_MODEL?.trim() || "anthropic/claude-sonnet-5.5",
} as const;

/**
 * Whether model calls can authenticate at all.
 *
 * An AI Gateway API key, or the OIDC token Vercel injects into deployments
 * that have the gateway enabled. Without either, the chat route answers
 * `503 CONFIGURATION_REQUIRED` up front rather than opening a stream that
 * fails on its first token — the same refuse-don't-stub rule as SES and Stripe.
 */
export function isModelConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY?.trim() || process.env.VERCEL_OIDC_TOKEN?.trim());
}

/**
 * The beta allowance: tokens per org per UTC calendar month, input and output
 * together (D47).
 *
 * The beta is free, so this is the whole cost control. D2 is why it exists:
 * model inference on every plan can outrun every other infrastructure line
 * combined, and a free feature with no ceiling is that risk on purpose. One
 * million tokens is a few dollars of Sonnet-class usage — generous for a
 * merchant tidying a catalog, a hard stop for a script looping on the chat
 * route. Overridable for a merchant who needs more during the beta.
 */
export const AGENT_MONTHLY_TOKEN_CAP = limitFromEnv("AGENT_BETA_MONTHLY_TOKENS", 1_000_000);

/**
 * Turns per person per hour. The cap bounds spend over a month; this bounds a
 * runaway client in an afternoon, before it has spent the month.
 */
export const AGENT_TURN_RATE_LIMIT: RateLimitPolicy = {
  limit: limitFromEnv("AGENT_TURNS_PER_HOUR", 60),
  windowMs: 60 * 60_000,
};

/**
 * Model steps per turn — each tool call and its follow-up is a step. Enough
 * to search, read a few products and propose; not enough to wander a catalog.
 */
export const AGENT_MAX_STEPS = 12;

/** Output tokens per step. A proposal is a tool call, not an essay. */
export const AGENT_MAX_OUTPUT_TOKENS = 2_000;

/**
 * Proposals one turn may create. `docs/AGENT-OPS.md` §3 caps bulk work per
 * action; this caps it per turn, so "rewrite all 400 descriptions" becomes a
 * reviewable batch the merchant asks to continue, not 400 cards at once.
 */
export const AGENT_MAX_PROPOSALS_PER_TURN = 20;

/** Start of the UTC month containing `now` — the window the cap is measured over. */
export function usagePeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Start of the next UTC month — when the allowance resets. */
export function usagePeriodEnd(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export type AgentAllowance = {
  usedTokens: number;
  capTokens: number;
  remainingTokens: number;
  /** False once the month's allowance is spent. A turn in progress finishes. */
  allowed: boolean;
  periodStart: string;
  resetsAt: string;
};

export function allowanceFor(usedTokens: number, now = new Date()): AgentAllowance {
  return {
    usedTokens,
    capTokens: AGENT_MONTHLY_TOKEN_CAP,
    remainingTokens: Math.max(0, AGENT_MONTHLY_TOKEN_CAP - usedTokens),
    allowed: usedTokens < AGENT_MONTHLY_TOKEN_CAP,
    periodStart: usagePeriodStart(now).toISOString(),
    resetsAt: usagePeriodEnd(now).toISOString(),
  };
}
