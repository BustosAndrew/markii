import type { ReactNode } from "react";
import type { DataValues } from "@markii/renderer/bindings";
import { DEFAULT_REGION_TREES } from "@markii/renderer/presets";
import { BuilderPage, BuilderRegion, type RenderContext } from "@markii/renderer/render";
import { cssProblems } from "@markii/renderer/sanitize";
import { ThemeShell } from "@markii/renderer/theme-shell";
import { resolveTheme } from "@markii/renderer/tokens";
import type { DocumentKind, PageNode } from "@markii/renderer/types";
import { storeView } from "@markii/renderer/views";
import { getCollectionProducts, getProducts, siteUrl, type StoreJson } from "./markii";

/**
 * A page of this store, drawn exactly as Markii draws it: the same renderer,
 * the same theme, the same published regions. Whatever the merchant has not
 * designed falls back to the renderer's own default layouts.
 */

/** A document from the published design, or null. */
export function documentOf(store: StoreJson, kind: DocumentKind, handle: string): PageNode | null {
  // Published trees carry their node ids; the package schema only makes them optional for imports.
  return (store.design?.documents.find((d) => d.kind === kind && d.handle === handle)?.tree as PageNode | undefined) ?? null;
}

export function seoOf(store: StoreJson, kind: DocumentKind, handle: string) {
  return store.design?.documents.find((d) => d.kind === kind && d.handle === handle)?.seo ?? {};
}

export async function renderContext(store: StoreJson, extra: Partial<RenderContext> = {}): Promise<RenderContext> {
  const products = await getProducts();
  const baseUrl = siteUrl();
  return {
    baseUrl,
    products,
    categories: store.categories,
    collections: store.collections,
    membersOf: (handle, limit) => getCollectionProducts(handle, limit),
    values: { store: storeView(store.store, { baseUrl, products, collections: store.collections }) },
    ...extra,
  };
}

export async function StorePage({
  store,
  tree,
  scope,
  extra,
  before,
  children,
}: {
  store: StoreJson;
  /** The page's document. Absent for a page drawn as plain storefront markup (`children`), like search results. */
  tree?: PageNode;
  children?: ReactNode;
  scope?: Omit<Partial<DataValues>, "store" | "item">;
  extra?: Partial<RenderContext>;
  /** Route-level structured data no design may remove. */
  before?: ReactNode;
}) {
  // Regions get the store alone, as on Markii; the page's own product, collection or page data is for the page.
  const shared = await renderContext(store);
  const ctx: RenderContext = { ...shared, ...extra, values: { ...shared.values, ...scope } };
  const theme = resolveTheme(store.design?.theme.themeId ?? store.store.themeId, store.design?.theme.tokens);
  const announcement = documentOf(store, "region", "announcement");
  const header = documentOf(store, "region", "header") ?? DEFAULT_REGION_TREES.header();
  const footer = documentOf(store, "region", "footer");
  const css = store.design?.theme.customCss ?? "";
  return (
    <ThemeShell theme={theme}>
      {before}
      {announcement ? <BuilderRegion region="announcement" tree={announcement} ctx={shared} /> : null}
      <BuilderRegion region="header" tree={header} ctx={shared} />
      {tree ? <BuilderPage tree={tree} ctx={ctx} /> : children}
      {footer ? <BuilderRegion region="footer" tree={footer} ctx={shared} /> : null}
      {/* Checked here as Markii checks it: it cannot contain "<", so it cannot leave this element. */}
      {css && cssProblems(css).length === 0 ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
    </ThemeShell>
  );
}

/** Structured data as a script tag. */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
