import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { StorefrontBuilderPage } from "@/components/storefront/builder-page";
import { ProductCard } from "@/components/storefront/product-card";
import { SiteHeader } from "@/components/storefront/site-header";
import { StorePaused } from "@/components/storefront/paused";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { loadSite, publishedPage, storefrontHalted } from "@/lib/storefront";

type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadSite((await params).site);
  if (!data) return {};
  const seo = (await publishedPage(data.site.id, "home"))?.seo;
  return {
    title: seo?.title || data.site.name,
    description:
      seo?.description ||
      (data.site.agentDiscovery ? `${data.site.name} — agent-readable store` : data.site.name),
    robots: data.site.indexed && !seo?.noindex ? undefined : { index: false },
    other: data.site.googleSiteVerification
      ? { "google-site-verification": data.site.googleSiteVerification }
      : undefined,
  };
}

export default async function StorePage({ params }: Props) {
  const data = await loadSite((await params).site);
  if (!data) notFound();
  const { site, bundle, colls, baseUrl } = data;
  const themeId = site.themeId ?? "studio";

  /**
   * The one page that explains itself instead of 404ing — a shopper who followed
   * a link deserves to know the store exists and is coming back. The reason is
   * **not** disclosed: "this merchant did not pay" is Markii's business with the
   * merchant, not something to publish to their customers.
   */
  if (storefrontHalted(data)) {
    return <StorePaused siteName={site.name} themeId={themeId} />;
  }

  await logTraffic({
    siteId: site.id,
    path: "/",
    userAgent: (await headers()).get("user-agent"),
  });

  /**
   * A published home design wins (D51); without one this is the fixed
   * storefront it has always been (`docs/BUILDER.md` §14 fallback).
   */
  const home = await publishedPage(site.id, "home");
  if (home) return <StorefrontBuilderPage data={data} tree={home.tree} />;

  const topCategories = bundle.categories.filter((c) => !c.parentSlug);

  return (
    <ThemeRoot themeId={themeId} theme={data.theme}>
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        accountHref={`${baseUrl}/account`}
        searchAction={`${baseUrl}/search`}
        collectionsHref={colls.length > 0 ? `${baseUrl}/collections` : undefined}
        nav={topCategories.map((c) => ({
          name: c.name,
          href: `${baseUrl}/c/${c.slug}`,
        }))}
      />
      <main className="sf-main">
        <header className="sf-hero">
          <h1 className="sf-title">{site.name}</h1>
          {site.agentDiscovery ? (
            <p className="sf-lede">
              Agent-readable store — see{" "}
              <a href={`${baseUrl}/llms.txt`}>llms.txt</a> and{" "}
              <a href={`${baseUrl}/agent.md`}>agent.md</a>.
            </p>
          ) : (
            <p className="sf-lede">Welcome to {site.name}.</p>
          )}
        </header>
        <ul className="sf-grid">
          {bundle.products.map((p) => (
            <ProductCard
              key={p.slug}
              name={p.name}
              href={`${baseUrl}/p/${p.slug}`}
              priceCents={p.priceCents}
              currency={p.currency}
              stock={p.stock}
              imageUrl={p.images[0]}
            />
          ))}
        </ul>
      </main>
    </ThemeRoot>
  );
}
