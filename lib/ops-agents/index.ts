import "server-only";

import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { ApiError } from "../api";
import type { AuthContext } from "../auth/session";
import { assertAccountStanding } from "../billing/standing-guard";
import { AGENT_KINDS, type AgentKind } from "../db";
import { consumeRateLimit } from "../rate-limit-store";
import { rateLimitHeaders } from "../rate-limit";
import { assistantInstructions, assistantTools } from "./assistant/agent";
import { helpTopics } from "./assistant/help";
import { catalogInstructions, catalogTools } from "./catalog/agent";
import { listStores } from "./catalog/reads";
import type { TurnContext } from "./propose-tools";
import {
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_MAX_STEPS,
  AGENT_MODELS,
  AGENT_TURN_RATE_LIMIT,
  isModelConfigured,
} from "./config";
import { mockModel, mockModelEnabled } from "./mock-model";
import { createSession, ownedSession, saveMessages, titleFrom } from "./sessions";
import { allowanceForOrg, recordUsage } from "./usage";

/**
 * Merchant agents (D47). One agent per area — Catalog first — plus the
 * general assistant, all sharing this turn loop, the proposal flow, the audit
 * trail and the beta cap.
 */

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(value);
}

/**
 * What the dashboard shows about each agent before a conversation starts.
 *
 * `href` is the page an agent lives on; `null` means it belongs on every
 * dashboard page, which is the assistant's whole point.
 */
export const AGENT_DIRECTORY: Record<
  AgentKind,
  { name: string; description: string; beta: true; href: string | null }
> = {
  assistant: {
    name: "Assistant",
    description:
      "Answers questions about Markii, walks you through setting up your store, and points you to " +
      "the right page or agent. Read-only — it changes nothing.",
    beta: true,
    href: null,
  },
  catalog: {
    name: "Catalog agent",
    description:
      "Finds gaps in your catalog and proposes fixes — copy, prices, collections, stock — for you to approve.",
    beta: true,
    href: "/dashboard/catalog",
  },
};

/**
 * One agent's instructions and tools for a turn.
 *
 * Both take the turn, because propose tools write proposal rows to this
 * session — the assistant's allowlist is empty, so it gets none.
 */
function agentSetup(
  agent: AgentKind,
  turn: TurnContext,
  auth: AuthContext,
  stores: Awaited<ReturnType<typeof listStores>>,
): { instructions: string; tools: ToolSet } {
  const scope = { orgId: auth.org.id, storeIds: auth.storeIds };
  switch (agent) {
    case "catalog":
      return {
        instructions: catalogInstructions({ stores, currency: auth.org.currency }),
        tools: catalogTools(turn, scope),
      };
    case "assistant": {
      const topics = helpTopics({ rootDomain: process.env.ROOT_DOMAIN?.trim() || "markii.shop" });
      return {
        instructions: assistantInstructions({
          stores,
          currency: auth.org.currency,
          role: auth.role,
          topics,
        }),
        tools: assistantTools(turn, auth, scope, topics),
      };
    }
  }
}

/**
 * The merchant's new message — and only that.
 *
 * Text parts only, role `user` only. The history comes from the database, so
 * a client cannot submit an assistant turn, a tool call, or a tool result: the
 * model only ever sees what this server recorded.
 */
export const chatTurnSchema = z.object({
  sessionId: z.string().regex(/^as_[a-z0-9]{20}$/).optional(),
  message: z.object({
    id: z.string().min(1).max(100),
    role: z.literal("user"),
    parts: z
      .array(z.object({ type: z.literal("text"), text: z.string().min(1).max(8_000) }))
      .min(1)
      .max(10),
  }),
});

async function modelFor(agent: AgentKind): Promise<LanguageModel> {
  if (mockModelEnabled()) return mockModel();
  if (!isModelConfigured()) {
    throw new ApiError(
      "CONFIGURATION_REQUIRED",
      503,
      "Merchant agents are not configured on this deployment.",
      {
        resolution:
          "Set AI_GATEWAY_API_KEY, or enable the Vercel AI Gateway for this project so its OIDC " +
          "token is available.",
      },
    );
  }
  return AGENT_MODELS[agent];
}

/**
 * Run one turn and stream it back.
 *
 * Every refusal happens **before** the stream opens, so it arrives as an
 * ordinary JSON error with a status code rather than as a half-written reply.
 */
export async function runAgentTurn(
  agent: AgentKind,
  auth: AuthContext,
  raw: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  if (!auth.user) {
    throw new ApiError(
      "UNAUTHORIZED",
      401,
      "Merchant agents are used from the dashboard. API tokens cannot start agent sessions — " +
        "an MCP client brings its own model (docs/MCP.md).",
    );
  }
  const userId = auth.user.id;
  const orgId = auth.org.id;
  const body = chatTurnSchema.parse(raw);

  const model = await modelFor(agent);

  /**
   * A held account cannot spend Markii's inference either. The proposals
   * would refuse at approval anyway (`invokeAction` gates writes on
   * standing), so letting the chat run would spend tokens producing changes
   * nobody can apply.
   */
  await assertAccountStanding(orgId, `agents.${agent}.chat`);

  const allowance = await allowanceForOrg(orgId);
  if (!allowance.allowed) {
    throw new ApiError(
      "QUOTA_EXCEEDED",
      409,
      "This month's agent allowance for the beta is used up.",
      {
        quota: "agent_tokens",
        ...allowance,
        resolution: `It resets on ${allowance.resetsAt.slice(0, 10)}.`,
      },
    );
  }

  const turnLimit = await consumeRateLimit(`agent:${userId}`, AGENT_TURN_RATE_LIMIT);
  if (!turnLimit.allowed) {
    throw new ApiError(
      "RATE_LIMITED",
      429,
      `Too many agent messages this hour. Try again in ${Math.ceil(turnLimit.retryAfterSeconds / 60)} minutes.`,
      { retryAfterSeconds: turnLimit.retryAfterSeconds },
      rateLimitHeaders(turnLimit, AGENT_TURN_RATE_LIMIT),
    );
  }

  const firstText = body.message.parts.map((p) => p.text).join("\n");
  const session = body.sessionId
    ? await ownedSession(body.sessionId, { orgId, userId })
    : await createSession({ orgId, userId, agent, title: titleFrom(firstText) });
  if (session.agent !== agent) {
    throw new ApiError("CONFLICT", 409, `That session belongs to the ${session.agent} agent.`);
  }

  const scope = { orgId, storeIds: auth.storeIds };
  const stores = await listStores(scope);
  const turn = {
    agent,
    orgId,
    userId,
    sessionId: session.id,
    actor: {
      type: "agent" as const,
      id: `agent:${agent}`,
      orgId,
      onBehalfOfUserId: userId,
      request: auth.actor.request,
    },
  };
  const { instructions, tools } = agentSetup(agent, turn, auth, stores);

  /**
   * The stored history is re-validated against **today's** tools. A tool
   * whose schema changed since the session began would otherwise hand the
   * model a call it can no longer make sense of.
   */
  const messages = await validateUIMessages({
    messages: [...(session.messages as UIMessage[]), body.message as UIMessage],
    // Widened only for validation, whose parameter is an index-signature
    // record; `streamText` below keeps the precise types.
    tools: tools as unknown as Parameters<typeof validateUIMessages>[0]["tools"],
  });

  const modelId = typeof model === "string" ? model : "mock";
  const result = streamText({
    model,
    instructions,
    messages: await convertToModelMessages(messages, { tools }),
    tools,
    stopWhen: isStepCount(AGENT_MAX_STEPS),
    maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
    abortSignal: signal,
    onEnd: async ({ usage }) => {
      await recordUsage({
        orgId,
        sessionId: session.id,
        agent,
        model: modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      onEnd: async ({ messages: finished }) => {
        await saveMessages(session.id, finished);
      },
    }),
    headers: {
      /** A new session's id, so the client sends it with the next message. */
      "x-agent-session-id": session.id,
      "cache-control": "no-store",
    },
  });
}
