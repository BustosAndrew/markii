import { and, eq } from "drizzle-orm";
import { cache } from "react";
import { accountStanding, storefrontHeld, type AccountStanding } from "@/lib/billing/standing";
import {
  categories,
  db,
  organizations,
  products,
  siteDesigns,
  siteDocuments,
  sites,
  type Category,
  type Collection,
  type Product,
  type Site,
} from "@/lib/db";
import { previewBaseFor, requestPreviewState } from "@/lib/builder/preview";
import { resolveTheme } from "@/lib/builder/tokens";
import { REGION_HANDLES, type DocumentKind, type PageNode, type PageSeo, type RegionHandle } from "@/lib/builder/types";
import { publishedCollectionsFor } from "@/lib/storefront/collections";
import type { ThemeTokens } from "@/lib/storefront/themes";
import { bundleFromDb, type Bundle } from "@/lib/generators";
import { storefrontUrl } from "@/lib/queries";

export type SiteData = {
  site: Site;
  cats: Category[];
  prods: Product[];
  /** Published only. Membership is resolved per page, not here — rules are evaluated at read time. */
  colls: Collection[];
  bundle: Bundle;
  baseUrl: string;
  /**
   * The published theme with the site's published design tokens applied
   * (D51). Every page hands it to `ThemeRoot`, so a published palette or font
   * reaches the whole storefront, not only builder pages.
   */
  theme: ThemeTokens;
  /**
   * True when this request is the builder's live preview of this site (D51):
   * pages render the **draft**, `theme` is the draft theme, and `baseUrl` keeps
   * every link inside the preview. Never true for a shopper — it needs a
   * preview token minted for this site and still unexpired.
   */
  preview: boolean;
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
  // The merchant previewing their own draft sees it whatever the store's state.
  if (data.preview) return false;
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
      pastDueSince: organizations.pastDueSince,
      suspendedAt: organizations.suspendedAt,
      suspendedReason: organizations.suspendedReason,
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
  const colls = await publishedCollectionsFor(site.id);
  const [design] = await db
    .select({
      publishedTokens: siteDesigns.publishedTokens,
      draftThemeId: siteDesigns.draftThemeId,
      draftTokens: siteDesigns.draftTokens,
    })
    .from(siteDesigns)
    .where(eq(siteDesigns.siteId, site.id))
    .limit(1);
  /**
   * A preview that was asked for but does not hold — expired, revoked, or a
   * token for another site — is a 404, not a quiet fall-back to the live store:
   * the editor must learn its session ended rather than show the wrong thing.
   */
  const previewState = await requestPreviewState();
  const preview = previewState.requested ? previewState.valid : null;
  if (previewState.requested && preview?.siteId !== site.id) return null;
  const inPreview = preview !== null;
  return {
    site,
    cats,
    prods,
    colls,
    bundle: bundleFromDb(site, cats, prods, colls),
    baseUrl: inPreview ? previewBaseFor(site.slug, preview.token) : storefrontUrl(site),
    theme: inPreview && design
      ? resolveTheme(design.draftThemeId, design.draftTokens)
      : resolveTheme(site.themeId, design?.publishedTokens),
    preview: inPreview,
    standing,
    /** A lapsed trial, the last rung of dunning (D10), or a platform suspension (G12) — Markii's hold, not the merchant's. */
    billingHold: storefrontHeld(standing),
  };
}

export type PublishedPage = { id: number; handle: string; title: string; seo: PageSeo; tree: PageNode };

/**
 * A document as **published** — the storefront never reads a draft (D51). Null
 * when the site has none by that handle, which means "render the fixed
 * layout" for the home page, a template, or a region (`docs/BUILDER.md` §14).
 */
export async function publishedDocument(siteId: number, kind: DocumentKind, handle: string): Promise<PublishedPage | null> {
  const [doc] = await db
    .select({
      id: siteDocuments.id,
      handle: siteDocuments.publishedHandle,
      title: siteDocuments.publishedTitle,
      seo: siteDocuments.publishedSeo,
      tree: siteDocuments.publishedTree,
    })
    .from(siteDocuments)
    .where(and(eq(siteDocuments.siteId, siteId), eq(siteDocuments.kind, kind), eq(siteDocuments.publishedHandle, handle)))
    .limit(1);
  if (!doc?.tree || !doc.handle) return null;
  return { id: doc.id, handle: doc.handle, title: doc.title ?? doc.handle, seo: doc.seo ?? {}, tree: doc.tree };
}

export function publishedPage(siteId: number, handle: string): Promise<PublishedPage | null> {
  return publishedDocument(siteId, "page", handle);
}

/**
 * The document a request should render: the **draft** in the builder's
 * preview, the published one everywhere else. Pages call this rather than
 * `publishedDocument` so preview and storefront cannot drift apart.
 */
export async function documentFor(data: SiteData, kind: DocumentKind, handle: string): Promise<PublishedPage | null> {
  if (!data.preview) return publishedDocument(data.site.id, kind, handle);
  const [doc] = await db
    .select({
      id: siteDocuments.id,
      handle: siteDocuments.handle,
      title: siteDocuments.title,
      seo: siteDocuments.seo,
      tree: siteDocuments.draftTree,
      deleted: siteDocuments.draftDeleted,
    })
    .from(siteDocuments)
    .where(and(eq(siteDocuments.siteId, data.site.id), eq(siteDocuments.kind, kind), eq(siteDocuments.handle, handle)))
    .limit(1);
  if (!doc || doc.deleted) return null;
  return { id: doc.id, handle: doc.handle, title: doc.title, seo: doc.seo ?? {}, tree: doc.tree };
}

export function pageFor(data: SiteData, handle: string): Promise<PublishedPage | null> {
  return documentFor(data, "page", handle);
}

export type Regions = Partial<Record<RegionHandle, PublishedPage>>;

/**
 * Every global region the request should render, in one query, once per
 * request however many components ask — the announcement bar, header and
 * footer each render from it.
 */
const loadRegions = cache(async (siteId: number, preview: boolean): Promise<Regions> => {
  const rows = await db
    .select({
      id: siteDocuments.id,
      handle: siteDocuments.handle,
      title: siteDocuments.title,
      deleted: siteDocuments.draftDeleted,
      draftTree: siteDocuments.draftTree,
      publishedHandle: siteDocuments.publishedHandle,
      publishedTree: siteDocuments.publishedTree,
    })
    .from(siteDocuments)
    .where(and(eq(siteDocuments.siteId, siteId), eq(siteDocuments.kind, "region")));
  const out: Regions = {};
  for (const r of rows) {
    const handle = preview ? r.handle : r.publishedHandle;
    const tree = preview ? (r.deleted ? null : r.draftTree) : r.publishedTree;
    if (!handle || !tree || !(REGION_HANDLES as readonly string[]).includes(handle)) continue;
    out[handle as RegionHandle] = { id: r.id, handle, title: r.title, seo: {}, tree };
  }
  return out;
});

export function regionsFor(data: SiteData): Promise<Regions> {
  return loadRegions(data.site.id, data.preview);
}
