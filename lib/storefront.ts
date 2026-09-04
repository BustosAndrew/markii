import { eq } from "drizzle-orm";
import { accountStanding, type AccountStanding } from "@/lib/billing/standing";
import {
  categories,
  db,
  organizations,
  products,
  sites,
  type Category,
  type Product,
  type Site,
} from "@/lib/db";
import { bundleFromDb, type Bundle } from "@/lib/generators";
import { storefrontUrl } from "@/lib/queries";

export type SiteData = {
  site: Site;
  cats: Category[];
  prods: Product[];
  bundle: Bundle;
  baseUrl: string;
  /**
   * The owning organization's standing with Markii, derived on this request.
   *
   * Carried here because `loadSite` is the one door every storefront page and
   * storefront API route already goes through — so a page cannot forget to ask,
   * and there is no second loader where the check could be missed.
   */
  standing: AccountStanding;
  /**
   * True when the trial ended with nothing bought. **Distinct from
   * `site.status === "paused"`**, which is the merchant pausing their own store:
   * one is their decision and the other is ours, they are undone by different
   * actions, and collapsing them would let a billing hold silently rewrite a
   * merchant's own setting.
   */
  billingHold: boolean;
};

/**
 * Whether the storefront must not serve — for **either** reason.
 *
 * The two causes stay separate everywhere they are recorded and are merged only
 * here, at the moment of asking "do we render". A merchant who paused their own
 * store and a merchant whose trial lapsed see different copy and reach different
 * remedies, but every page asks one question, so no page can check one cause and
 * forget the other.
 */
export function storefrontHalted(data: SiteData): boolean {
  return data.site.status === "paused" || data.billingHold;
}

/** Everything a storefront page/route needs, from the [site] slug segment. */
export async function loadSite(siteSlug: string): Promise<SiteData | null> {
  const [site] = await db.select().from(sites).where(eq(sites.slug, siteSlug)).limit(1);
  if (!site) return null;

  const [org] = await db
    .select({
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      subscriptionStatus: organizations.subscriptionStatus,
      freeTrialEndsAt: organizations.freeTrialEndsAt,
    })
    .from(organizations)
    .where(eq(organizations.id, site.orgId))
    .limit(1);

  /**
   * A storefront whose org row is missing is a broken foreign key, not an unpaid
   * account. Serving it beats dark-siting a merchant over Markii's own bug.
   */
  const standing: AccountStanding = org
    ? accountStanding(org)
    : { state: "ungated", reason: "No organization row for this site." };

  const cats = await db.select().from(categories).where(eq(categories.siteId, site.id));
  const prods = await db.select().from(products).where(eq(products.siteId, site.id));
  return {
    site,
    cats,
    prods,
    bundle: bundleFromDb(site, cats, prods),
    baseUrl: storefrontUrl(site),
    standing,
    billingHold: standing.state === "expired",
  };
}
