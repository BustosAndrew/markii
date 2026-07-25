import { eq } from "drizzle-orm";
import { categories, db, products, sites, type Category, type Product, type Site } from "@/lib/db";
import { bundleFromDb, type Bundle } from "@/lib/generators";
import { storefrontUrl } from "@/lib/queries";

export type SiteData = {
  site: Site;
  cats: Category[];
  prods: Product[];
  bundle: Bundle;
  baseUrl: string;
};

/** Everything a storefront page/route needs, from the [site] slug segment. */
export async function loadSite(siteSlug: string): Promise<SiteData | null> {
  const [site] = await db.select().from(sites).where(eq(sites.slug, siteSlug)).limit(1);
  if (!site) return null;
  const cats = await db.select().from(categories).where(eq(categories.siteId, site.id));
  const prods = await db.select().from(products).where(eq(products.siteId, site.id));
  return {
    site,
    cats,
    prods,
    bundle: bundleFromDb(site, cats, prods),
    baseUrl: storefrontUrl(site),
  };
}
