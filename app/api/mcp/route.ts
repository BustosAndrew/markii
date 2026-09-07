import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api";
import { isReportableToolError, rpcErrorPayload, toolErrorPayload } from "@/lib/mcp/errors";
import { MCP_RATE_LIMIT, rateLimitHeaders } from "@/lib/rate-limit";
import { consumeRateLimit } from "@/lib/rate-limit-store";
/**
 * **From the barrel, not from `./registry` and `./invoke` directly.**
 *
 * `lib/actions/index.ts` is what performs the side-effect imports that register
 * every definition *and* install the authorization resolver. Importing the
 * submodules instead compiles and typechecks perfectly, and then behaves
 * differently depending on what else happened to be loaded into the process
 * first: in a warm instance where a dashboard route ran earlier the registry is
 * full, and in a cold one where `/api/mcp` is the first request, `allActions()`
 * is empty and `authorize()` denies everything. This is what caught it — one
 * tool resolving while another reported "no such tool" in the same server.
 */
import {
  allActions,
  authorize,
  describeAction,
  getAction,
  invokeAction,
} from "@/lib/actions";
import { mcpAuthContext } from "@/lib/auth/session";
import type { AuthContext } from "@/lib/auth/session";
import {
  isNotification,
  isValidRequest,
  rpcError,
  rpcResult,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RPC_RESOURCE_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcRequest,
} from "@/lib/mcp/jsonrpc";
import { findPrompt, promptList, renderPrompt } from "@/lib/mcp/prompts";
import { callReadTool, findReadTool, readTools } from "@/lib/mcp/reads";
import {
  readResource,
  resourceList,
  ResourceNotFound,
  resourceTemplates,
} from "@/lib/mcp/resources";
import {
  actionIdFor,
  negotiateProtocolVersion,
  splitDryRun,
  visibleTools,
} from "@/lib/mcp/tools";

/**
 * `ALL /api/mcp` — the MCP server (§22, `docs/BUILDER.md` §10).
 *
 * The registry as tools, so an MCP client (Claude Code, Cursor) can operate a
 * Markii store through the **same** validation, permissions, step-up, account
 * standing and audit trail as a click in the dashboard. That parity is not a
 * nice property, it is the reason `defineAction` exists — §22 rule 1 makes the
 * registry the only mutation path, so this route adds a *surface*, never a
 * capability. There is no privileged path here and nothing to keep in sync.
 *
 * **Stateless.** Every POST is self-contained: no session id, no server-initiated
 * messages, no SSE stream. That is a deliberate fit for the deployment — there
 * is no persistent process and no session store here, and a stateful transport
 * would need both. It costs the features nothing currently uses.
 *
 * **Token-only auth (rule 6).** `mcpAuthContext` accepts a scoped
 * `Authorization: Bearer mk_live_…` and refuses a session cookie, so an MCP
 * client can never inherit ambient browser authority.
 */

/** Generous: a tool call runs a real action, including its post-commit effects. */
export const maxDuration = 300;

/**
 * The raw `Authorization` header rides along because the read tools re-present
 * it to the route handlers they call, so those re-authorize on their own terms
 * rather than trusting a session this layer already resolved.
 */
type Ctx = { session: AuthContext; authorization: string };

export async function POST(req: Request) {
  const session = await mcpAuthContext(req);
  if (!session) {
    /**
     * **401 with `WWW-Authenticate`**, which is what an MCP client reads to
     * discover it needs a credential. A bare 403 tells it nothing actionable.
     */
    return NextResponse.json(
      rpcError(
        null,
        RPC_INVALID_REQUEST,
        "This MCP server requires a scoped Markii API token. Create one under " +
          "Settings → Team → API tokens and send it as `Authorization: Bearer mk_live_…`. " +
          "A dashboard session cookie is deliberately not accepted.",
      ),
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="markii"' } },
    );
  }

  /** Non-null: `mcpAuthContext` only succeeds when a bearer token was present. */
  const authorization = req.headers.get("authorization") ?? "";

  /**
   * **Rate limited per token, and only after authentication.**
   *
   * Keyed on the token's id rather than the caller's address: MCP is
   * token-authenticated, an IP is shared behind NAT and forgeable without a
   * trusted proxy in front, and the token is the thing that can actually be
   * revoked. It also keeps one merchant's runaway agent from spending another's
   * allowance.
   *
   * After auth, so an unauthenticated flood cannot fill the counter table with
   * keys nobody owns — an anonymous caller is already refused a line earlier and
   * costs one indexed token lookup.
   *
   * This is an abuse control, not a security boundary. It **fails open** if the
   * counter is unreachable, because the things that actually stand between a
   * caller and the data — the permission check, the approval gate, the audit
   * log — do not depend on it, and a degraded counter should not become an
   * outage.
   */
  const limitKey = `mcp:${session.token?.id ?? session.actor.id}`;
  const limit = await consumeRateLimit(limitKey, MCP_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      rpcError(
        null,
        RPC_INVALID_REQUEST,
        `Rate limit exceeded: ${MCP_RATE_LIMIT.limit} requests per minute for this token. ` +
          `Retry in ${limit.retryAfterSeconds}s.`,
      ),
      { status: 429, headers: rateLimitHeaders(limit, MCP_RATE_LIMIT) },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(rpcError(null, RPC_PARSE_ERROR, "Invalid JSON"), { status: 400 });
  }

  /**
   * A batch is a JSON array. Handled because the spec allows one, and a client
   * that sends one to a server that cannot read it fails in a way that looks
   * like the server is broken.
   */
  if (Array.isArray(body)) {
    const replies = [];
    for (const msg of body) {
      const reply = await handleMessage(msg, { session, authorization });
      if (reply) replies.push(reply);
    }
    // An all-notification batch is answered with no body, per JSON-RPC.
    const batchHeaders = rateLimitHeaders(limit, MCP_RATE_LIMIT);
    return replies.length
      ? NextResponse.json(replies, { headers: batchHeaders })
      : new Response(null, { status: 202, headers: batchHeaders });
  }

  /**
   * The budget travels on every reply, not only the refusal — a client that can
   * see `RateLimit-Remaining` falling can slow down before it is turned away,
   * which is the entire point of publishing it.
   */
  const headers = rateLimitHeaders(limit, MCP_RATE_LIMIT);

  const reply = await handleMessage(body, { session, authorization });
  return reply
    ? NextResponse.json(reply, { headers })
    : new Response(null, { status: 202, headers });
}

/**
 * `GET` is where a stateful server would open its SSE stream. This one has
 * nothing to push, and **405 with `Allow: POST` is the honest answer** — a
 * client that gets an empty 200 stream instead will wait on it forever.
 */
export function GET() {
  return NextResponse.json(
    rpcError(
      null,
      RPC_INVALID_REQUEST,
      "This MCP server is stateless: it does not open an SSE stream. Send JSON-RPC over POST.",
    ),
    { status: 405, headers: { Allow: "POST" } },
  );
}

/** No session to terminate, so there is nothing for DELETE to do. */
export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

async function handleMessage(msg: unknown, ctx: Ctx) {
  if (!isValidRequest(msg)) {
    return rpcError(null, RPC_INVALID_REQUEST, "Not a JSON-RPC 2.0 request");
  }

  const id: JsonRpcId = msg.id ?? null;

  try {
    const result = await dispatch(msg, ctx);
    // A notification is answered with silence, never with a result.
    if (isNotification(msg)) return null;
    if (result === undefined) {
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown method "${msg.method}"`);
    }
    return rpcResult(id, result);
  } catch (e) {
    if (isNotification(msg)) return null;
    /**
     * The one place a code other than the JSON-RPC four is used: the MCP spec
     * names `-32002` for a URI that does not resolve, and a client that can
     * tell that apart from a malformed request gives a better message than one
     * that cannot.
     */
    if (e instanceof ResourceNotFound) {
      return rpcError(id, RPC_RESOURCE_NOT_FOUND, e.message, { uri: e.uri });
    }
    if (e instanceof ApiError) {
      const { message, data } = rpcErrorPayload(e);
      return rpcError(id, RPC_INVALID_PARAMS, message, data);
    }
    /**
     * **Never echo raw exception text**, exactly as `errorResponse` does not —
     * a driver error carries table and column names, and a config error can
     * carry an env var name. Both are for logs, not for a model.
     */
    console.error("[mcp] unhandled error", e);
    return rpcError(id, RPC_INTERNAL_ERROR, rpcErrorPayload(e).message);
  }
}

async function dispatch(msg: JsonRpcRequest, ctx: Ctx): Promise<unknown> {
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        /**
         * **`subscribe: false` on resources, and that is a claim not to be
         * inflated.** Advertising it would tell a client it may call
         * `resources/subscribe` and be notified when a store changes; this
         * server is stateless, holds no connection to push down, and would
         * simply never send the notification. `listChanged` is false for the
         * same reason on all three.
         */
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: "markii", version: "1.0.0" },
        instructions:
          "Markii commerce platform. `read_*` tools query the store; every other tool is a " +
          "registry action, validated and audited identically to a dashboard click. Start with " +
          "read_store, and read before you write — the write tools take ids that only a read " +
          "produces. High-risk tools refuse to run unattended: call them with \"_dryRun\": true " +
          "and hand the resulting diff to a person to approve. Resources carry the standing " +
          "context: markii://store for the currency every amount is in, and markii://conventions " +
          "for the rules this server enforces.",
      };

    /** Notifications: acknowledged by returning, answered by nothing. */
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return {};

    case "tools/list":
      /**
       * **Reads first.** An agent picks from the top of a list it may not read
       * in full, and every write tool here needs an id that only a read
       * produces — so leading with the mutations invites guessing at ids.
       */
      return {
        tools: [
          ...readTools(),
          ...(await visibleTools(allActions(), describeAction, (permission) =>
            authorize(ctx.session.actor, permission),
          )),
        ],
      };

    case "tools/call":
      return await callTool(params, ctx);

    case "resources/list":
      return { resources: resourceList() };

    case "resources/templates/list":
      return { resourceTemplates: resourceTemplates() };

    case "resources/read": {
      const uri = params.uri;
      if (typeof uri !== "string") {
        throw new ApiError("VALIDATION_ERROR", 400, "resources/read requires a uri");
      }
      /**
       * **Not a tool result.** A tool error is the right answer when a model
       * picked the wrong thing and could pick again; a resource URI was chosen
       * by the *client* off a list it was handed, so a failure here is a
       * protocol-level answer to the client, not material for a model to reason
       * about.
       */
      return { contents: await readResource(uri, ctx) };
    }

    case "prompts/list":
      return { prompts: promptList() };

    case "prompts/get": {
      const name = params.name;
      if (typeof name !== "string") {
        throw new ApiError("VALIDATION_ERROR", 400, "prompts/get requires a prompt name");
      }
      const prompt = findPrompt(name);
      /**
       * **A JSON-RPC error, unlike an unknown *tool*.** A missing prompt is a
       * bad request from the client, which chose the name off a list it was
       * given — there is no model in the loop to recover by choosing
       * differently, which is the whole reason a bad tool name is a tool error
       * instead.
       */
      if (!prompt) {
        throw new ApiError("NOT_FOUND", 404, `No such prompt "${name}"`);
      }
      return renderPrompt(prompt, (params.arguments ?? {}) as Record<string, string>);
    }

    default:
      return undefined;
  }
}

async function callTool(params: Record<string, unknown>, ctx: Ctx) {
  const name = params.name;
  if (typeof name !== "string") {
    throw new ApiError("VALIDATION_ERROR", 400, "tools/call requires a tool name");
  }

  /**
   * Read tools are checked first and are **not** registry actions — see
   * `lib/mcp/reads.ts` for why listing a catalog must not write an audit row.
   * The `read_` prefix keeps the two namespaces from ever colliding, which a
   * test asserts rather than assumes.
   */
  const read = findReadTool(name);
  if (read) {
    const authorization = ctx.authorization;
    const { status, body } = await callReadTool(
      read,
      (params.arguments ?? {}) as Record<string, unknown>,
      authorization,
    );
    /**
     * A refused or failed read is a **tool error carrying the route's own body**
     * — the handler already answered in Markii's error shape, and rewriting it
     * here would give the agent a second vocabulary for the same failure.
     */
    if (status >= 400) {
      return toolError(JSON.stringify(body, null, 2));
    }
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body as Record<string, unknown>,
      isError: false,
    };
  }

  const actionId = actionIdFor(name);
  const def = getAction(actionId);
  if (!def) {
    /**
     * An unknown tool is reported as a **tool error, not a protocol error**.
     * The call was well-formed; it named something that does not exist, and an
     * agent recovers from that by picking a different tool rather than by
     * treating the connection as broken.
     */
    return toolError(`No such tool "${name}". Call tools/list to see what is available.`);
  }

  const { dryRun, input } = splitDryRun(params.arguments);

  try {
    const outcome = await invokeAction(actionId, input, { actor: ctx.session.actor, dryRun });
    return {
      content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
      structuredContent: outcome as Record<string, unknown>,
      isError: false,
    };
  } catch (e) {
    /**
     * **An action's refusal is a tool result, not a JSON-RPC error.** A protocol
     * error says "this server could not process your message", which tells the
     * model nothing it can act on; a tool error puts the reason in the
     * transcript, where it can read "high-risk, dry-run it and ask a human" and
     * do exactly that. Bad arguments go the same way — that is the most frequent
     * mistake a model makes, and calling it a transport fault hides the field
     * name it needs.
     */
    if (isReportableToolError(e)) return toolError(toolErrorPayload(e));
    throw e;
  }
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * **Read tools are live (`lib/mcp/reads.ts`); MCP *resources* are not.**
 *
 * `read_*` covers what an agent needs to act — find a product, find an order,
 * read the store's plan and readiness — by forwarding to the existing `GET`
 * handlers, so org scoping and permissions are the dashboard's own and nothing
 * is reimplemented. Deliberately not registry actions: every invocation writes
 * an `action_invocations` row, and a browsing agent would bury the audit log.
 *
 * **`resources/*` landed 2026-09-07** (`lib/mcp/resources.ts`) and the two do
 * different jobs. A resource is stable context a *client* pins into a
 * conversation — the org and its currency, the storefront index, the operating
 * rules, and the `llms.txt` / `agent.md` a store actually publishes. A tool is a
 * query a model runs when it needs an answer. Keeping the resource set small is
 * what preserves that difference: mirroring every read tool as a resource would
 * give a model two ways to ask one question and no rule for choosing.
 */
