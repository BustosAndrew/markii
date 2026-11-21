import { agentDocument } from "../../lib/agent-docs";

/** `GET /agent.md` — the store's own, from Markii, with its pages pointed at this site (`lib/agent-docs.ts`). */
export function GET() {
  return agentDocument("/agent.md", "text/markdown; charset=utf-8");
}
