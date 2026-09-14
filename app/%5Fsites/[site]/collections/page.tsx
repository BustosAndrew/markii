import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { loadSite, storefrontHalted } from "@/lib/storefront";

type Props = { params: Promise<{ site: string }> };

/**
 * `/collections` — every published collection (§18.2). Server-rendered like the
 * rest of the storefront; a collection is a merchandising surface, and one the
 * merchant built and switched on deserves a page that lists it.
 */

function strip(html: string | null | undefined) {
  return (html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadSite((await params).site);
  if (!data) return {};
  return {
    title: `Collections — ${data.site.name}`,
    robots: data.site.indexed ? undefined : { index: false },
  };
}

export default async function CollectionsPage({ params }: Props) {
  const data = await loadSite((await params).site);
  if (!data || storefrontHalted(data)) notFound();
  const { site, bundle, colls, baseUrl } = data;

  await logTraffic({
    siteId: site.id,
    path: "/collections",
    userAgent: (await headers()).get("user-agent"),
  });

  const topCategories = bundle.categories.filter((c) => !c.parentSlug);
  const themeId = site.themeId ?? "studio";

  return (
    <ThemeRoot themeId={themeId}>
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        accountHref={`${baseUrl}/account`}
        searchAction={`${baseUrl}/search`}
        collectionsHref={colls.length > 0 ? `${baseUrl}/collections` : undefined}
        nav={topCategories.map((c) => ({ name: c.name, href: `${baseUrl}/c/${c.slug}` }))}
      />
      <main className="sf-main">
        <p className="sf-crumb">
          <a href={`${baseUrl}/`}>{site.name}</a> / Collections
        </p>
        <header className="sf-hero">
          <h1 className="sf-title">Collections</h1>
          {colls.length === 0 ? (
            <p className="sf-lede">No collections yet.</p>
          ) : null}
        </header>
        {colls.length > 0 ? (
          <ul className="sf-list" aria-label="Collections">
            {colls.map((c) => (
              <li key={c.id}>
                <a href={`${baseUrl}/collections/${c.handle}`}>{c.title}</a>
                {c.description ? <span className="sf-muted">{strip(c.description)}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </ThemeRoot>
  );
}
