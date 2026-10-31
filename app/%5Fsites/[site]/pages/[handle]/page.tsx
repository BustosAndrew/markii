import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { StorefrontBuilderPage } from "@/components/storefront/builder-page";
import { logTraffic } from "@/lib/agents";
import { loadSite, publishedPage, storefrontHalted } from "@/lib/storefront";

/**
 * A merchant's own page — about, shipping, FAQ — designed in the builder and
 * served at `/pages/{handle}` once published (D51). Only published pages
 * exist here; a draft page is a 404 until its publish.
 */

type Props = { params: Promise<{ site: string; handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data) return {};
  const page = await publishedPage(data.site.id, handle);
  if (!page) return {};
  return {
    title: page.seo.title || `${page.title} — ${data.site.name}`,
    description: page.seo.description || undefined,
    robots: data.site.indexed && !page.seo.noindex ? undefined : { index: false },
  };
}

export default async function BuilderPageRoute({ params }: Props) {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data || storefrontHalted(data)) notFound();
  // The home page is served at /, not twice.
  if (handle === "home") notFound();
  const page = await publishedPage(data.site.id, handle);
  if (!page) notFound();

  await logTraffic({
    siteId: data.site.id,
    path: `/pages/${handle}`,
    userAgent: (await headers()).get("user-agent"),
  });

  return <StorefrontBuilderPage data={data} tree={page.tree} />;
}
