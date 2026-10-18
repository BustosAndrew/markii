import { notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { isAgentKind, runAgentTurn } from "@/lib/ops-agents";

/**
 * `POST /api/agents/:agent/chat` — one turn with a merchant agent (D47).
 *
 * Body: `{ sessionId?, message }` — the merchant's **new** message only; the
 * history is loaded server-side. Streams an AI SDK UI message stream; a new
 * session's id comes back in `x-agent-session-id`.
 *
 * `catalog.read` to talk to any agent — every role holds it, so the assistant
 * is open to the whole team. Proposing needs `catalog.write`, checked inside
 * each proposal's dry run with the asker's role — a viewer can ask questions
 * and is told plainly when a change is beyond their role. The assistant
 * proposes nothing at all.
 *
 * Node runtime (the default), which streams without any route config.
 */
export const POST = orgHandler(
  async (req, { params, session }) => {
    const { agent } = await params;
    if (!isAgentKind(agent)) throw notFound("Agent");
    return runAgentTurn(agent, session, await req.json(), req.signal);
  },
  { permission: "catalog.read" },
);
