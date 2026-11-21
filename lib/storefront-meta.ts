import type { Metadata } from "next";
import type { PageSeo } from "@markii/renderer/types";
import type { SiteData } from "@/lib/storefront";

/**
 * A storefront page's link-preview and canonical tags (M5): Open Graph from
 * the page's own SEO fields, and the canonical URL on the store's real
 * address — `baseUrl` is the verified custom domain when there is one, so a
 * store reachable at both its subdomain and its domain names one of them.
 */
export function pageSocialMetadata(
  data: SiteData,
  page: { title: string; description?: string; path: string; seo?: PageSeo },
): Pick<Metadata, "openGraph" | "alternates"> {
  const url = `${data.baseUrl.replace(/\/$/, "")}${page.path === "/" ? "/" : page.path}`;
  const image = page.seo?.ogImage;
  return {
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      url,
      siteName: data.site.name,
      title: page.title,
      ...(page.description ? { description: page.description } : {}),
      ...(image ? { images: [{ url: image }] } : {}),
    },
  };
}
