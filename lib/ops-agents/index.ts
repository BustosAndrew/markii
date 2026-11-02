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
import { roleHasPermission } from "../auth/permissions";
import { acquireAgentLease, AGENT_LEASE_RENEW_MS, releaseAgentLease, renewAgentLease } from "../builder/lease";
import { AGENT_KINDS, type AgentKind } from "../db";
import { consumeRateLimit } from "../rate-limit-store";
import { rateLimitHeaders } from "../rate-limit";
import { assistantInstructions, assistantTools } from "./assistant/agent";
import { helpTopics } from "./assistant/help";
import { brandInstructions, brandTools } from "./brand/agent";
import { brandSite, editorContextSchema, liveContext, type EditorContext } from "./brand/context";
import { previousTurnStart } from "./brand/format";
import { catalogInstructions, catalogTools } from "./catalog/agent";
import { listStores } from "./catalog/reads";
import type { TurnContext } from "./propose-tools";
import {
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_MAX_STEPS,
  AGENT_MODELS,
  AGENT_TURN_RATE_LIMIT,
  BRAND_MAX_OUTPUT_TOKENS,
  BRAND_MAX_STEPS,
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
  {
    name: string;
    description: string;
    beta: true;
    href: string | null;
    /**
     * Where the chat opens: the dashboard's agent drawer, or inside the site
     * editor — the brand agent works on one storefront's design beside its
     * preview, so a drawer on another page has nothing to show it working on.
     */
    surface: "drawer" | "editor";
  }
> = {
  assistant: {
    name: "Assistant",
    description:
      "Answers questions about Markii, walks you through setting up your store, and points you to " +
      "the right page or agent. Read-only — it changes nothing.",
    beta: true,
    href: null,
    surface: "drawer",
  },
  catalog: {
    name: "Catalog agent",
    description:
      "Finds gaps in your catalog and proposes fixes — copy, prices, collections, stock — for you to approve.",
    beta: true,
    href: "/dashboard/catalog",
    surface: "drawer",
  },
  brand: {
    name: "Brand agent",
    description:
      "Redesigns your storefront with you — layout, copy, colours, fonts — in the site editor, beside " +
      "a live preview. It edits your draft; nothing goes live until you publish.",
    beta: true,
    href: "/dashboard/websites",
    surface: "editor",
  },
};

/** What a brand turn is bound to: one site, and where the merchant is in its editor. */
type BrandBinding = {
  site: Awaited<ReturnType<typeof brandSite>>;
  editor: EditorContext;
  since: Date | null;
  onWrite: () => void;
};

/**
 * One agent's instructions and tools for a turn.
 *
 * Both take the turn, because propose tools write proposal rows to this
 * session — the assistant's allowlist is empty, so it gets none.
 */
async function agentSetup(
  agent: AgentKind,
  turn: TurnContext,
  auth: AuthContext,
  stores: Awaited<ReturnType<typeof listStores>>,
  brand: BrandBinding | null,
): Promise<{ instructions: string; tools: ToolSet }> {
  const scope = { orgId: auth.org.id, storeIds: auth.storeIds };
  switch (agent) {
    case "brand": {
      if (!brand) throw new Error("A brand turn needs its site binding");
      const live = await liveContext({
        orgId: auth.org.id,
        userId: turn.userId,
        sessionId: turn.sessionId,
        site: brand.site,
        editor: brand.editor,
        since: brand.since,
      });
      return {
        instructions: brandInstructions({ siteName: brand.site.name, currency: auth.org.currency, live }),
        tools: brandTools(turn, scope, brand.site.id, brand.onWrite),
      };
    }
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
  /**
   * Where the merchant is in the site editor (brand agent only): site, open
   * page, selected block, breakpoint. Every field is re-checked against the
   * site before it reaches the model — it is a hint about attention, never a
   * grant of scope.
   */
  context: editorContextSchema.optional(),
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

  const scope = { orgId, storeIds: auth.storeIds };

  /**
   * The brand agent edits for real, so it runs only for someone who could
   * make the same edits by hand. Checked here rather than left to each
   * action's permission check, because the turn takes the edit lease first —
   * a viewer's turn would otherwise lock the editor against the people who
   * may use it, to make edits that are then all refused.
   */
  let site: Awaited<ReturnType<typeof brandSite>> | null = null;
  if (agent === "brand") {
    if (!body.context) {
      throw new ApiError("VALIDATION_ERROR", 400, "The brand agent works on one site: send `context.siteId`.");
    }
    if (!roleHasPermission(auth.role, "cms.write")) {
      throw new ApiError("FORBIDDEN", 403, "Your role cannot edit site designs, so it cannot use the brand agent.", {
        permission: "cms.write",
      });
    }
    site = await brandSite(scope, body.context.siteId);
  }

  const firstText = body.message.parts.map((p) => p.text).join("\n");
  const session = body.sessionId
    ? await ownedSession(body.sessionId, { orgId, userId })
    : await createSession({ orgId, userId, agent, siteId: site?.id ?? null, title: titleFrom(firstText) });
  if (session.agent !== agent) {
    throw new ApiError("CONFLICT", 409, `That session belongs to the ${session.agent} agent.`);
  }
  if (site && session.siteId !== site.id) {
    throw new ApiError("CONFLICT", 409, "That conversation is about another site. Start a new one here.");
  }

  const stores = await listStores(scope);
  const turn = {
    agent,
    orgId,
    userId,
    sessionId: session.id,
    /**
     * `id` is the person the agent acts for, which is what the audit log
     * resolves an agent's name through (`lib/org/audit-query.ts`): an agent's
     * row reads as that person's agent rather than an id nobody can name.
     */
    actor: {
      type: "agent" as const,
      id: userId,
      orgId,
      onBehalfOfUserId: userId,
      sessionId: session.id,
      request: auth.actor.request,
    },
  };

  const history = session.messages as UIMessage[];
  const turnStartedAt = new Date();
  /**
   * The new message carries when it was sent. That timestamp is how the next
   * turn knows where "changes since your last reply" begin — kept in the
   * transcript rather than a column so it needs no migration and cannot
   * disagree with the message it describes.
   */
  const userMessage = { ...body.message, metadata: { sentAt: turnStartedAt.toISOString() } } as UIMessage;

  /**
   * Abort when the client goes away **or** the lease is lost. Stop reaches the
   * server as `builder.stopAgent`, which frees the lease; the next renewal
   * notices and ends the turn here even if the chat's own abort never arrived.
   */
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });

  let finish = async () => {};
  if (site) {
    const boundSite = site;
    await acquireAgentLease(boundSite.id, session.id);
    const heartbeat = setInterval(() => {
      void renewAgentLease(boundSite.id, session.id).then(
        (held) => {
          if (!held) controller.abort(new Error("The agent's edit lease was released."));
        },
        () => {},
      );
    }, AGENT_LEASE_RENEW_MS);
    let finished = false;
    finish = async () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      await releaseAgentLease(boundSite.id, session.id);
    };
    controller.signal.addEventListener("abort", () => void finish(), { once: true });
  }

  let instructions: string;
  let tools: ToolSet;
  try {
    const bound = site;
    ({ instructions, tools } = await agentSetup(
      agent,
      turn,
      auth,
      stores,
      bound && body.context
        ? {
            site: bound,
            editor: body.context,
            since: previousTurnStart(history),
            // Each edit renews the lease too, so a long run of writes cannot outlive it between heartbeats.
            onWrite: () => void renewAgentLease(bound.id, session.id).catch(() => {}),
          }
        : null,
    ));
    // Recorded before the model runs, so a turn that dies mid-stream still marks where it began.
    if (bound) await saveMessages(session.id, [...history, userMessage]);
  } catch (e) {
    await finish();
    throw e;
  }

  /**
   * The stored history is re-validated against **today's** tools. A tool
   * whose schema changed since the session began would otherwise hand the
   * model a call it can no longer make sense of.
   */
  const messages = await validateUIMessages({
    messages: [...history, userMessage],
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
    stopWhen: isStepCount(agent === "brand" ? BRAND_MAX_STEPS : AGENT_MAX_STEPS),
    maxOutputTokens: agent === "brand" ? BRAND_MAX_OUTPUT_TOKENS : AGENT_MAX_OUTPUT_TOKENS,
    abortSignal: controller.signal,
    onError: () => finish(),
    onAbort: () => finish(),
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
      /**
       * Without this the SDK leaves the reply's id empty, so every stored
       * assistant message shared the id "" and a resumed transcript rendered
       * with duplicate React keys.
       */
      generateMessageId: () => `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      onEnd: async ({ messages: finished }) => {
        // Saved before the lease goes back, so the next turn's "since" never postdates an edit made after it.
        await saveMessages(session.id, finished);
        await finish();
      },
    }),
    headers: {
      /** A new session's id, so the client sends it with the next message. */
      "x-agent-session-id": session.id,
      "cache-control": "no-store",
    },
  });
}
