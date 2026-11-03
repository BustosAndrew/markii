import { SiteHeader } from "@/components/storefront/site-header";
import { BuilderRegion, type RenderContext } from "@/lib/builder/render";
import { storeView } from "@/lib/builder/views";
import { regionsFor, type SiteData } from "@/lib/storefront";

/**
 * What surrounds every storefront page (M4): the announcement bar and the
 * header above it, the footer below. Each is the merchant's **published
 * region** when they have one — edited once in the builder, shown on every page
 * — and otherwise exactly what the storefront has always rendered: the fixed
 * header, and no announcement bar or footer at all (`docs/BUILDER.md` §14).
 *
 * Every page renders these rather than `SiteHeader` directly, so no page can
 * show a header the merchant replaced.
 */

/** The render context every builder document on a page shares — store data, links, catalogue. */
export function builderContext(data: SiteData, extra: Partial<RenderContext> = {}): RenderContext {
  const { baseUrl, prods, cats, colls, preview, site } = data;
  return {
    baseUrl,
    products: prods,
    categories: cats,
    collections: colls,
    preview,
    values: { store: storeView(site, { baseUrl, products: prods, collections: colls }) },
    ...extra,
  };
}

export async function StoreTop({
  data,
  searchQuery,
  minimal = false,
}: {
  data: SiteData;
  searchQuery?: string;
  /** The fixed header's cart/account variant — no search box or collections link. A designed header is used as designed. */
  minimal?: boolean;
}) {
  const regions = await regionsFor(data);
  const { site, bundle, colls, baseUrl } = data;
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);
  return (
    <>
      {regions.announcement ? (
        <BuilderRegion
          region="announcement"
          tree={regions.announcement.tree}
          ctx={builderContext(data, { documentId: regions.announcement.id })}
        />
      ) : null}
      {regions.header ? (
        <BuilderRegion region="header" tree={regions.header.tree} ctx={builderContext(data, { documentId: regions.header.id, searchQuery })} />
      ) : (
        <SiteHeader
          siteName={site.name}
          homeHref={`${baseUrl}/`}
          cartHref={`${baseUrl}/cart`}
          accountHref={`${baseUrl}/account`}
          searchAction={minimal ? undefined : `${baseUrl}/search`}
          searchQuery={searchQuery}
          collectionsHref={!minimal && colls.length > 0 ? `${baseUrl}/collections` : undefined}
          nav={topCategories.map((c) => ({ name: c.name, href: `${baseUrl}/c/${c.slug}` }))}
        />
      )}
    </>
  );
}

export async function StoreFooter({ data }: { data: SiteData }) {
  const regions = await regionsFor(data);
  if (!regions.footer) return null;
  return <BuilderRegion region="footer" tree={regions.footer.tree} ctx={builderContext(data, { documentId: regions.footer.id })} />;
}
