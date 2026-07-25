import { logTraffic } from "@/lib/agents";
import { generateAgentMd } from "@/lib/generators";
import { defaultWallet } from "@/lib/integrations";
import { loadSite } from "@/lib/storefront";

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const data = await loadSite((await params).site);
  if (!data || !data.site.agentDiscovery || data.site.status === "paused") {
    return new Response("Not found", { status: 404 });
  }
  await logTraffic({
    siteId: data.site.id,
    path: "/agent.md",
    userAgent: req.headers.get("user-agent"),
  });
  const payTo = data.site.walletAddress ?? (await defaultWallet());
  return new Response(generateAgentMd(data.bundle, data.baseUrl, { payTo }), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
