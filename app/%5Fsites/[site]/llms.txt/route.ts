import { logTraffic } from "@/lib/agents";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { renderLlmsTxt } from "@/lib/storefront-docs";

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const data = await loadSite((await params).site);
  if (!data || !data.site.agentDiscovery || storefrontHalted(data)) {
    return new Response("Not found", { status: 404 });
  }
  await logTraffic({
    siteId: data.site.id,
    path: "/llms.txt",
    userAgent: req.headers.get("user-agent"),
  });
  const body = renderLlmsTxt(data);
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
