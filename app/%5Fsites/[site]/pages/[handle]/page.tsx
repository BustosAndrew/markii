import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { redirectOrNotFound } from "@/lib/storefront/redirects";
import { StorefrontBuilderPage } from "@/components/storefront/builder-page";
import { logTraffic } from "@/lib/agents";
import { loadSite, pageFor, storefrontHalted } from "@/lib/storefront";
import { pageSocialMetadata } from "@/lib/storefront-meta";

/**
 * A merchant's own page — about, shipping, FAQ — designed in the builder and
 * served at `/pages/{handle}` once published (D51). Only published pages
 * exist here — a draft page is a 404 until its publish — except in the
 * builder's live preview, where `pageFor` returns the draft.
 */

type Props = { params: Promise<{ site: string; handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data) return {};
  const page = await pageFor(data, handle);
  if (!page) return {};
  const title = page.seo.title || `${page.title} — ${data.site.name}`;
  const description = page.seo.description || undefined;
  return {
    title,
    description,
    robots: data.site.indexed && !page.seo.noindex ? undefined : { index: false },
    ...pageSocialMetadata(data, { title, description, path: `/pages/${page.handle}`, seo: page.seo }),
  };
}

export default async function BuilderPageRoute({ params }: Props) {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data || storefrontHalted(data)) notFound();
  // The home page is served at /, not twice.
  if (handle === "home") notFound();
  const page = await pageFor(data, handle);
  if (!page) return redirectOrNotFound(data, `/pages/${handle}`);

  await logTraffic({
    siteId: data.site.id,
    path: `/pages/${handle}`,
    userAgent: (await headers()).get("user-agent"),
  });

  return (
    <StorefrontBuilderPage
      data={data}
      tree={page.tree}
      documentId={page.id}
      extra={{
        page: {
          name: page.seo.title || page.title,
          description: page.seo.description || undefined,
          url: `${data.baseUrl.replace(/\/$/, "")}/pages/${page.handle}`,
        },
      }}
    />
  );
}
