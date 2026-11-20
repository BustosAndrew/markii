import "server-only";
import { notFound } from "@/lib/api";
import { packageSourceRows } from "@/lib/builder/queries";
import { packageFromDesign, type ThemePackage } from "@/lib/builder/theme-package";
import { loadSite, storefrontHalted, type SiteData } from "@/lib/storefront";

/**
 * The one door the storefront read API (D53) goes through — `loadSite`, as
 * every storefront route does, so standing and the merchant's own pause apply
 * without a route having to remember them.
 *
 * Two refusals, both a plain 404 like the storefront's own pages: a **halted**
 * store (shoppers are told it is unavailable, never why), and a request under
 * the builder's **preview** — the read API serves the published store only,
 * and a draft must never become readable by whoever holds a preview link.
 * `proxy.ts` already refuses storefront APIs under a preview; this holds if
 * that ever changes.
 */
export async function loadReadableSite(slug: string): Promise<SiteData> {
  const data = await loadSite(slug);
  if (!data || data.preview || storefrontHalted(data)) throw notFound("Store");
  return data;
}

/** The store's published design as a theme package, or null when nothing is published. */
export async function publishedDesign(data: SiteData): Promise<ThemePackage | null> {
  const rows = await packageSourceRows(data.site.id);
  if (!rows) return null;
  return packageFromDesign({
    source: "published",
    publishedThemeId: data.site.themeId,
    design: rows.design,
    documents: rows.documents,
    savedBlocks: [],
  });
}
