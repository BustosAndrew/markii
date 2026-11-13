import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { StorefrontBuilderPage } from "@/components/storefront/builder-page";
import { ProductCard } from "@/components/storefront/product-card";
import { StoreFooter, StoreTop } from "@/components/storefront/store-chrome";
import { StorePaused } from "@/components/storefront/paused";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { websiteJsonLd } from "@/lib/generators";
import { loadSite, pageFor, storefrontHalted } from "@/lib/storefront";
import { pageSocialMetadata } from "@/lib/storefront-meta";

type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadSite((await params).site);
  if (!data) return {};
  const seo = (await pageFor(data, "home"))?.seo;
  const title = seo?.title || data.site.name;
  const description =
    seo?.description ||
    (data.site.agentDiscovery ? `${data.site.name} — agent-readable store` : data.site.name);
  return {
    title,
    description,
    robots: data.site.indexed && !seo?.noindex ? undefined : { index: false },
    ...pageSocialMetadata(data, { title, description, path: "/", seo }),
    other: data.site.googleSiteVerification
      ? { "google-site-verification": data.site.googleSiteVerification }
      : undefined,
  };
}

export default async function StorePage({ params }: Props) {
  const data = await loadSite((await params).site);
  if (!data) notFound();
  const { site, bundle, baseUrl } = data;
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
  // The store's WebSite + SearchAction, whichever layout the home page has (M5).
  const websiteLd = (
    <script
      type="application/ld+json"
      // Built here from the store's own name and address; `<` escaped so a name cannot close the tag.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd(site.name, baseUrl)).replace(/</g, "\\u003c") }}
    />
  );

  const home = await pageFor(data, "home");
  if (home) {
    return (
      <StorefrontBuilderPage
        data={data}
        tree={home.tree}
        documentId={home.id}
        before={websiteLd}
        extra={{ page: { name: home.seo.title || site.name, description: home.seo.description || undefined, url: `${baseUrl}/` } }}
      />
    );
  }


  return (
    <ThemeRoot themeId={themeId} theme={data.theme} preview={data.preview}>
      {websiteLd}
      <StoreTop data={data} />
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
      <StoreFooter data={data} />
    </ThemeRoot>
  );
}
