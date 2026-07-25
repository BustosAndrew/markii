import { logTraffic } from "@/lib/agents";
import { generateLlmsTxt } from "@/lib/generators";
import { loadSite } from "@/lib/storefront";

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const data = await loadSite((await params).site);
  if (!data || !data.site.agentDiscovery || data.site.status === "paused") {
    return new Response("Not found", { status: 404 });
  }
  await logTraffic({
    siteId: data.site.id,
    path: "/llms.txt",
    userAgent: req.headers.get("user-agent"),
  });
  return new Response(generateLlmsTxt(data.bundle, data.baseUrl), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
