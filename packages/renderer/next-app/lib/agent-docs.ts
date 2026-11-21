import { siteUrl, storeUrl } from "./markii";

/**
 * The store's agent documents — `llms.txt`, `llms-full.txt`, `agent.md`,
 * `sitemap.xml` — served from this site, as Markii writes them, with the
 * store's pages pointed here. **Its APIs stay pointed at Markii**: search,
 * cart and the x402 checkout an agent reads about in `agent.md` are served by
 * the store on Markii, not by this app, so rewriting them would send agents
 * to routes that do not exist here.
 *
 * Markii answers 404 when the merchant has agent discovery off, and so does this.
 */
export async function agentDocument(path: string, contentType: string): Promise<Response> {
  const store = storeUrl();
  const res = await fetch(`${store}${path}`, { next: { revalidate: 300 } });
  if (!res.ok) return new Response("Not found", { status: 404 });
  const here = siteUrl();
  const text = await res.text();
  const body = here ? text.replace(new RegExp(`${escape(store)}(?!/api/)`, "g"), here) : text;
  return new Response(body, { headers: { "content-type": contentType, "cache-control": "public, max-age=300" } });
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
