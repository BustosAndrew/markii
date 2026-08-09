import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ProductCard } from "@/components/storefront/product-card";
import { SiteHeader } from "@/components/storefront/site-header";
import { StorePaused } from "@/components/storefront/paused";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { loadSite } from "@/lib/storefront";

type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadSite((await params).site);
  if (!data) return {};
  return {
    title: data.site.name,
    description: data.site.agentDiscovery
      ? `${data.site.name} — agent-readable store`
      : data.site.name,
    robots: data.site.indexed ? undefined : { index: false },
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

  if (site.status === "paused") {
    return <StorePaused siteName={site.name} themeId={themeId} />;
  }

  await logTraffic({
    siteId: site.id,
    path: "/",
    userAgent: (await headers()).get("user-agent"),
  });

  const topCategories = bundle.categories.filter((c) => !c.parentSlug);

  return (
    <ThemeRoot themeId={themeId}>
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        nav={topCategories.map((c) => ({
          name: c.name,
          href: `${baseUrl}/c/${c.slug}`,
        }))}
      />
      <main className="sf-main">
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
