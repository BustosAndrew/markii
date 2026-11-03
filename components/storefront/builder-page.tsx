import type { ReactNode } from "react";
import { StoreFooter, StoreTop, builderContext } from "@/components/storefront/store-chrome";
import { ThemeRoot } from "@/components/storefront/theme-root";
import type { DataValues } from "@/lib/builder/bindings";
import { BuilderPage, type RenderContext } from "@/lib/builder/render";
import type { PageNode } from "@/lib/builder/types";
import type { SiteData } from "@/lib/storefront";

/**
 * A builder document on the storefront (D51): the site's theme and global
 * regions around the rendered node tree — a page, or (M4) a product or
 * collection template rendered for one product or collection, whose data
 * arrives in `scope`.
 *
 * Server-rendered with no client JavaScript beyond the sanctioned islands.
 */
export function StorefrontBuilderPage({
  data,
  tree,
  documentId,
  scope,
  extra,
  before,
}: {
  data: SiteData;
  tree: PageNode;
  documentId?: number;
  /** The template's own data — the product or collection the page is for. The store is always added. */
  scope?: Omit<Partial<DataValues>, "store" | "item">;
  extra?: Omit<Partial<RenderContext>, "values">;
  /** Route-level structured data that no design may remove (a template's Product or CollectionPage JSON-LD). */
  before?: ReactNode;
}) {
  const ctx = builderContext(data, { documentId, ...extra });
  ctx.values = { ...ctx.values, ...scope };
  return (
    <ThemeRoot themeId={data.site.themeId} theme={data.theme} preview={data.preview}>
      {before}
      <StoreTop data={data} />
      <BuilderPage tree={tree} ctx={ctx} />
      <StoreFooter data={data} />
    </ThemeRoot>
  );
}
