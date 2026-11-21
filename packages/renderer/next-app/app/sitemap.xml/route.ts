import { agentDocument } from "../../lib/agent-docs";

/** `GET /sitemap.xml` — the store's own, from Markii, with its pages pointed at this site (`lib/agent-docs.ts`). */
export function GET() {
  return agentDocument("/sitemap.xml", "application/xml; charset=utf-8");
}
