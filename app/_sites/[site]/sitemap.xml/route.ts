import { generateSitemapXml } from "@/lib/generators";
import { loadSite } from "@/lib/storefront";

export async function GET(_req: Request, { params }: { params: Promise<{ site: string }> }) {
  const data = await loadSite((await params).site);
  if (!data || data.site.status === "paused") return new Response("Not found", { status: 404 });
  if (!data.site.indexed) return new Response("Not found", { status: 404 });
  return new Response(generateSitemapXml(data.bundle, data.baseUrl), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
