import { agentDocument } from "../../lib/agent-docs";

/** `GET /llms.txt` — the store's own, from Markii, with its pages pointed at this site (`lib/agent-docs.ts`). */
export function GET() {
  return agentDocument("/llms.txt", "text/plain; charset=utf-8");
}
