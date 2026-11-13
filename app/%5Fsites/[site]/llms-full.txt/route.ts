import { logTraffic } from "@/lib/agents";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { renderLlmsFullTxt } from "@/lib/storefront-docs";

/**
 * The full text of the store's own published pages as Markdown (M5) — the
 * llms.txt convention's companion document, linked from `llms.txt` and
 * `agent.md`. Gated exactly like `llms.txt`: agent discovery off, or the store
 * halted, is a 404. A store with no published pages has nothing to serve and
 * answers 404 rather than an empty document.
 */
export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const data = await loadSite((await params).site);
  if (!data || !data.site.agentDiscovery || storefrontHalted(data)) {
    return new Response("Not found", { status: 404 });
  }
  const body = await renderLlmsFullTxt(data);
  if (body === null) return new Response("Not found", { status: 404 });
  await logTraffic({
    siteId: data.site.id,
    path: "/llms-full.txt",
    userAgent: req.headers.get("user-agent"),
  });
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
