import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApiError } from "@/lib/api";
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
  type JsonRpcId,
  type JsonRpcRequest,
} from "@/lib/mcp/jsonrpc";
import { callReadTool, findReadTool, readTools } from "@/lib/mcp/reads";
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
    return replies.length ? NextResponse.json(replies) : new Response(null, { status: 202 });
  }

  const reply = await handleMessage(body, { session, authorization });
  return reply ? NextResponse.json(reply) : new Response(null, { status: 202 });
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
    if (e instanceof ApiError) {
      return rpcError(id, RPC_INVALID_PARAMS, e.message, { code: e.code, details: e.details });
    }
    return rpcError(id, RPC_INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }
}

async function dispatch(msg: JsonRpcRequest, ctx: Ctx): Promise<unknown> {
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        /** Tools only — `resources/*` is still unbuilt; see the note below. */
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "markii", version: "1.0.0" },
        instructions:
          "Markii commerce platform. `read_*` tools query the store; every other tool is a " +
          "registry action, validated and audited identically to a dashboard click. Start with " +
          "read_store, and read before you write — the write tools take ids that only a read " +
          "produces. High-risk tools refuse to run unattended: call them with \"_dryRun\": true " +
          "and hand the resulting diff to a person to approve.",
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
     * **An action's refusal is a tool result, not a JSON-RPC error.** This is the
     * distinction the spec draws and the easy one to get wrong: a protocol error
     * says "this server could not process your message", which tells the model
     * nothing it can act on. A tool error puts the reason in the transcript,
     * where the model can read "high-risk, dry-run it and ask a human" and do
     * exactly that.
     */
    if (e instanceof ApiError) {
      return toolError(
        JSON.stringify({ code: e.code, message: e.message, details: e.details }, null, 2),
      );
    }
    /**
     * **Bad arguments are a tool error too, and this is the common case.**
     *
     * `def.input.parse()` throws a `ZodError`, which is not an `ApiError` — so
     * this used to fall through to a JSON-RPC `-32603`, telling the client the
     * *server* had failed. Getting an argument's type wrong is the single most
     * frequent thing a model does, and reporting it as a transport fault hides
     * the one thing that would let it recover: which field, and what was
     * expected. Returned as a tool error, the issues land in the transcript and
     * the next attempt is usually right.
     */
    if (e instanceof ZodError) {
      return toolError(
        JSON.stringify(
          {
            code: "VALIDATION_ERROR",
            message: "The arguments did not match this tool's input schema.",
            issues: e.issues.map((i) => ({
              field: i.path.join(".") || "(root)",
              message: i.message,
            })),
          },
          null,
          2,
        ),
      );
    }
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
 * `resources/*` remains unbuilt, and `initialize` does not advertise the
 * capability. Resources are for stable context a *client* attaches — the store
 * as a document — rather than for querying, which is what these tools do. Worth
 * adding when a client wants to pin store context into a conversation; not a
 * substitute for anything above.
 */
