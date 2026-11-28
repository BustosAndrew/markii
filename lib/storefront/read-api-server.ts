import "server-only";
import { notFound } from "@/lib/api";
import { packageSourceRows } from "@/lib/builder/queries";
import { packageFromDesign, type ThemePackage } from "@markii/renderer/theme-package";
import { loadSite, storefrontHalted, type SiteData } from "@/lib/storefront";
import type { PageNode } from "@markii/renderer/types";

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

export type MembersOnlyPage = { handle: string; requiresTierId: number };

/**
 * The store's published design as a theme package, or null when nothing is
 * published — and the pages in it that are members-only (§18.9).
 *
 * **A members-only page's tree is withheld**: it is replaced by an empty root
 * before the package is built, because this answer is public and cached, and
 * the tree *is* the paid content. Its title and SEO stay, as on its own page.
 * A reader asks `GET /api/pages/{handle}` for the tree, on a shopper's behalf.
 */
export async function publishedDesign(data: SiteData): Promise<{ design: ThemePackage | null; membersOnlyPages: MembersOnlyPage[] }> {
  const rows = await packageSourceRows(data.site.id);
  if (!rows) return { design: null, membersOnlyPages: [] };
  const membersOnlyPages: MembersOnlyPage[] = [];
  const documents = rows.documents.map((d) => {
    if (d.kind !== "page" || d.publishedRequiresTierId == null || !d.publishedTree) return d;
    membersOnlyPages.push({ handle: d.publishedHandle ?? d.handle, requiresTierId: d.publishedRequiresTierId });
    return { ...d, publishedTree: withheldTree(d.publishedTree) };
  });
  const design = packageFromDesign({
    source: "published",
    publishedThemeId: data.site.themeId,
    design: rows.design,
    documents,
    savedBlocks: [],
  });
  return { design, membersOnlyPages };
}

/** The page's own root with nothing in it — the same node id, so nothing that follows ids breaks. */
export function withheldTree(tree: PageNode): PageNode {
  return { id: tree.id, type: tree.type, props: {}, children: [] };
}
