import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { formatPrice } from "@/lib/generators";
import { loadSite } from "@/lib/storefront";

type Props = { params: Promise<{ site: string; categorySlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, categorySlug } = await params;
  const data = await loadSite(siteSlug);
  const cat = data?.cats.find((c) => c.slug === categorySlug);
  if (!data || !cat) return {};
  return {
    title: `${cat.name} — ${data.site.name}`,
    robots: data.site.indexed ? undefined : { index: false },
  };
}

export default async function CategoryPage({ params }: Props) {
  const { site: siteSlug, categorySlug } = await params;
  const data = await loadSite(siteSlug);
  if (!data) notFound();
  const { site, cats, prods, bundle, baseUrl } = data;
  const category = cats.find((c) => c.slug === categorySlug && c.enabled);
  if (!category || site.status === "paused") notFound();

  await logTraffic({
    siteId: site.id,
    path: `/c/${categorySlug}`,
    userAgent: (await headers()).get("user-agent"),
  });

  const children = cats.filter((c) => c.parentId === category.id && c.enabled);
  const categoryIds = [category.id, ...children.map((c) => c.id)];
  const items = prods.filter(
    (p) => p.enabled && p.categoryId != null && categoryIds.includes(p.categoryId),
  );
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);
  const themeId = site.themeId ?? "studio";

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
        <p className="sf-crumb">
          <a href={`${baseUrl}/`}>{site.name}</a> / {category.name}
        </p>
        <header className="sf-hero">
          <h1 className="sf-title">{category.name}</h1>
          {category.description ? (
            <p className="sf-lede">{category.description}</p>
          ) : null}
        </header>
        {children.length > 0 ? (
          <nav className="sf-nav" aria-label="Subcategories">
            {children.map((c) => (
              <a key={c.slug} href={`${baseUrl}/c/${c.slug}`}>
                {c.name}
              </a>
            ))}
          </nav>
        ) : null}
        <ul className="sf-list">
          {items.map((p) => (
            <li key={p.id}>
              <a href={`${baseUrl}/p/${p.slug}`}>{p.name}</a>
              <span>
                <strong className="sf-price">
                  {formatPrice(p.priceCents, p.currency)}
                </strong>
                <span className="sf-muted">
                  {" "}
                  — {p.stock > 0 ? `${p.stock} in stock` : "out of stock"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </main>
    </ThemeRoot>
  );
}
