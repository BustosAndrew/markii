import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { BuilderPage } from "@/lib/builder/render";
import type { PageNode } from "@/lib/builder/types";
import type { SiteData } from "@/lib/storefront";

/**
 * A builder page on the storefront (D51): the site's theme and header around
 * the rendered node tree. The header stays the fixed one until global regions
 * land (M4); everything below it is the merchant's design.
 *
 * Server-rendered with no client JavaScript, like every storefront page.
 */
export function StorefrontBuilderPage({
  data,
  tree,
  preview = false,
}: {
  data: SiteData;
  tree: PageNode;
  preview?: boolean;
}) {
  const { site, bundle, colls, baseUrl, cats, prods } = data;
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);
  return (
    <ThemeRoot themeId={site.themeId} theme={data.theme}>
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        accountHref={`${baseUrl}/account`}
        searchAction={`${baseUrl}/search`}
        collectionsHref={colls.length > 0 ? `${baseUrl}/collections` : undefined}
        nav={topCategories.map((c) => ({ name: c.name, href: `${baseUrl}/c/${c.slug}` }))}
      />
      <BuilderPage
        tree={tree}
        ctx={{ baseUrl, products: prods, categories: cats, collections: colls, preview }}
      />
    </ThemeRoot>
  );
}
