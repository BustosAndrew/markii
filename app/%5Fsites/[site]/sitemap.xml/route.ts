import { loadSite, storefrontHalted } from "@/lib/storefront";
import { renderSitemapXml } from "@/lib/storefront-docs";

export async function GET(_req: Request, { params }: { params: Promise<{ site: string }> }) {
  const data = await loadSite((await params).site);
  if (!data || storefrontHalted(data)) return new Response("Not found", { status: 404 });
  if (!data.site.indexed) return new Response("Not found", { status: 404 });
  return new Response(await renderSitemapXml(data), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
