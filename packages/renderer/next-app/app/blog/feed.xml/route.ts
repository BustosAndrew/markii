import { agentDocument } from "../../../lib/agent-docs";

/**
 * `GET /blog/feed.xml` — the store's RSS feed, from Markii, with its post links
 * pointed at this site (`lib/agent-docs.ts`). Feed readers and agents subscribe
 * to it instead of polling `/blog`.
 */
export function GET() {
  return agentDocument("/blog/feed.xml", "application/rss+xml; charset=utf-8");
}
