import { z } from "zod";
import { getBlock } from "./blocks";
import { sanitizeHtml } from "./sanitize";
import { designTokensSchema, type DesignTokens } from "./tokens";
import { nodeInputSchema, type NodeInput } from "./tree";
import {
  CUSTOM_CSS_MAX,
  DOCUMENT_KINDS,
  HOME_HANDLE,
  REGION_HANDLES,
  TEMPLATE_HANDLES,
  type DocumentKind,
  type PageNode,
  type PageSeo,
} from "./types";

/**
 * The theme package (D53): a store's design as one portable document — the
 * unit for store-to-store copy, file export/import, the theme marketplace and
 * the design half of a store export, so the four cannot diverge.
 *
 * **What travels:** the theme and its tokens, theme CSS, every page, template
 * and region as its node tree, and the saved blocks. **What never does:**
 * head code (custom scripts) — a script is executable code from outside the
 * store, so the importing store keeps its own and a person re-enters any they
 * want through `builder.setHeadCode`, with its step-up; and anything keyed by
 * a row id, which means nothing in another store (blocks name products,
 * categories and collections by slug and handle).
 *
 * **Images are the one thing that needs work to move**, because each is a
 * URL. They can sit in exactly four places, and {@link mapImages} is the one
 * walker over all four — listing references and rewriting them are the same
 * traversal, so they cannot disagree about what counts:
 *
 * 1. a block prop whose editor field is `kind: "image"` (today `image.src`
 *    and `storeBrand.logoSrc` — found from the registry, so a new image prop
 *    joins without anyone remembering to add it here);
 * 2. a page's `seo.ogImage`;
 * 3. `<img src>` inside a custom HTML block;
 * 4. `url()` in the theme CSS.
 *
 * **A new place that can hold an image URL must join {@link mapImages}**, or a
 * package silently ships a link back to the seller's store.
 *
 * Pure: no database, storage or environment, so the editor, the actions and
 * the unit tests share one definition.
 */

export const THEME_PACKAGE_FORMAT = "markii.theme" as const;
export const THEME_PACKAGE_VERSION = 1 as const;

/** A bundled image, by content: `asset:` + its SHA-256 in lowercase hex. */
export const ASSET_REF = /^asset:([a-f0-9]{64})$/;

export const PACKAGE_LIMITS = {
  maxDocuments: 100,
  maxSavedBlocks: 100,
  maxAssets: 100,
  /** One image — the same ceiling `POST /api/uploads` puts on an upload. */
  maxAssetBytes: 5 * 1024 * 1024,
  /** Every image together. A theme is a design, not a media library. */
  maxTotalAssetBytes: 25 * 1024 * 1024,
} as const;

/** Images a package may carry — exactly what `POST /api/uploads` accepts. */
export const ASSET_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const httpsImage = z.string().max(2000).regex(/^https:\/\/\S+$/, "Use an https:// image URL.");

/** A page's SEO fields — the one schema `builder.updatePage` and an import both apply. */
export const pageSeoSchema = z
  .object({
    title: z.string().max(120).optional(),
    description: z.string().max(320).optional(),
    // Kept out of search results, the sitemap, llms.txt and llms-full.txt alike (M5).
    noindex: z.boolean().optional(),
    ogImage: httpsImage.optional(),
  })
  .strict();

const pageHandle = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, digits and single hyphens, like about-us.")
  .max(60);

/**
 * One document. The tree is checked only for shape here; every block, prop,
 * binding and custom HTML block is checked by `validateTree` when the package
 * is applied, exactly as any other edit is.
 */
function documentSchema<S extends z.ZodType<PageSeo>>(seo: S) {
  return z
    .object({
      kind: z.enum(DOCUMENT_KINDS),
      handle: z.string().min(1).max(60),
      title: z.string().trim().min(1).max(120),
      seo: (seo as unknown as z.ZodType<PageSeo, PageSeo>).default({}),
      tree: nodeInputSchema,
    })
    .strict();
}

const savedBlockSchema = z.object({ name: z.string().trim().min(1).max(60), node: nodeInputSchema }).strict();

function packageSchema<S extends z.ZodType<PageSeo>>(seo: S) {
  return z
    .object({
      format: z.literal(THEME_PACKAGE_FORMAT),
      version: z.literal(THEME_PACKAGE_VERSION),
      name: z.string().trim().max(120).optional(),
      theme: z
        .object({
          themeId: z.enum(["studio", "atlas", "noir", "bloom"]),
          tokens: designTokensSchema.default({}),
          customCss: z.string().max(CUSTOM_CSS_MAX * 2).default(""),
        })
        .strict(),
      documents: z.array(documentSchema(seo)).min(1).max(PACKAGE_LIMITS.maxDocuments),
      savedBlocks: z.array(savedBlockSchema).max(PACKAGE_LIMITS.maxSavedBlocks).default([]),
    })
    .strict();
}

/**
 * A package ready to apply: every image is a real https URL. The input schema
 * of `builder.importTheme`.
 */
export const themePackageSchema = packageSchema(pageSeoSchema);
export type ThemePackage = z.infer<typeof themePackageSchema>;
export type PackageDocument = ThemePackage["documents"][number];

const assetSchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    contentType: z.enum(Object.keys(ASSET_TYPES) as [string, ...string[]]),
    /** Base64. Checked against `hash` before anything is stored. */
    data: z.string().min(1),
  })
  .strict();

/**
 * A package as a file: images may be `asset:{sha256}` tokens, with the bytes in
 * `assets`. Image fields are loose here because a token is not an https URL;
 * {@link unbundledPackage} resolves every token and re-checks the result
 * against {@link themePackageSchema}.
 */
export const themeFileSchema = packageSchema(pageSeoSchema.extend({ ogImage: z.string().max(2000).optional() })).extend({
  assets: z.array(assetSchema).max(PACKAGE_LIMITS.maxAssets).default([]),
});
export type ThemeFile = z.infer<typeof themeFileSchema>;

// ---------------------------------------------------------------------------
// Building a package from a design
// ---------------------------------------------------------------------------

type DesignRows = {
  draftThemeId: string;
  draftTokens: DesignTokens;
  publishedTokens: DesignTokens;
  draftCustomCss: string;
  publishedCustomCss: string;
};

type DocumentRow = {
  kind: DocumentKind;
  handle: string;
  title: string;
  seo: PageSeo;
  draftTree: PageNode;
  draftDeleted: boolean;
  publishedHandle: string | null;
  publishedTitle: string | null;
  publishedSeo: PageSeo | null;
  publishedTree: PageNode | null;
};

export type PackageSource = "draft" | "published";

/**
 * A store's design as a package — what the editor shows (`draft`) or what
 * shoppers see (`published`). Returns null for `published` when nothing has
 * been published. Head code is left out on purpose (see the module note).
 */
export function packageFromDesign(input: {
  name?: string;
  source: PackageSource;
  /** `sites.themeId` — where the published theme lives. */
  publishedThemeId: string;
  design: DesignRows;
  documents: DocumentRow[];
  savedBlocks: { name: string; node: NodeInput }[];
}): ThemePackage | null {
  const published = input.source === "published";
  const documents: PackageDocument[] = [];
  for (const d of input.documents) {
    if (published) {
      if (!d.publishedTree) continue;
      documents.push({
        kind: d.kind,
        handle: d.publishedHandle ?? d.handle,
        title: d.publishedTitle ?? d.title,
        seo: d.publishedSeo ?? {},
        tree: d.publishedTree,
      });
    } else {
      if (d.draftDeleted) continue;
      documents.push({ kind: d.kind, handle: d.handle, title: d.title, seo: d.seo ?? {}, tree: d.draftTree });
    }
  }
  if (documents.length === 0) return null;
  return {
    format: THEME_PACKAGE_FORMAT,
    version: THEME_PACKAGE_VERSION,
    ...(input.name ? { name: input.name } : {}),
    theme: {
      themeId: (published ? input.publishedThemeId : input.design.draftThemeId) as ThemePackage["theme"]["themeId"],
      tokens: published ? input.design.publishedTokens : input.design.draftTokens,
      customCss: published ? input.design.publishedCustomCss : input.design.draftCustomCss,
    },
    documents,
    savedBlocks: input.savedBlocks.map((b) => ({ name: b.name, node: b.node })),
  };
}

/**
 * The structural rules a package's documents must keep before any tree is
 * looked at: a home page, page handles that are addresses, templates and
 * regions only under the handles that exist, and no two documents in one slot.
 * Returns the problems, empty when there are none.
 */
export function documentProblems(documents: { kind: DocumentKind; handle: string }[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of documents) {
    const key = `${d.kind}:${d.handle}`;
    if (seen.has(key)) problems.push(`Two ${d.kind}s use the handle "${d.handle}".`);
    seen.add(key);
    if (d.kind === "page" && d.handle !== HOME_HANDLE && !pageHandle.safeParse(d.handle).success) {
      problems.push(`"${d.handle}" is not a page address — lowercase letters, digits and single hyphens.`);
    }
    if (d.kind === "template" && !(TEMPLATE_HANDLES as readonly string[]).includes(d.handle)) {
      problems.push(`There is no "${d.handle}" template (templates: ${TEMPLATE_HANDLES.join(", ")}).`);
    }
    if (d.kind === "region" && !(REGION_HANDLES as readonly string[]).includes(d.handle)) {
      problems.push(`There is no "${d.handle}" region (regions: ${REGION_HANDLES.join(", ")}).`);
    }
  }
  if (!seen.has(`page:${HOME_HANDLE}`)) problems.push("A theme package must include the home page.");
  return problems;
}

// ---------------------------------------------------------------------------
// Images — the one walker
// ---------------------------------------------------------------------------

export type ImagePlace = "block" | "seo" | "html" | "css";

/** Where an image reference was found, for reports a person can act on. */
export type ImageRef = { url: string; place: ImagePlace; where: string };

/** Returns the replacement URL, or the same one to leave it. */
export type ImageMapper = (url: string, ref: Omit<ImageRef, "url">) => string;

type TreeLike = { id?: string; type: string; props?: Record<string, unknown>; children?: TreeLike[] };

/** The block props that hold an image, from each block's own editor fields. */
function imageProps(type: string): string[] {
  return (getBlock(type)?.editorPanel ?? []).filter((f) => f.kind === "image").map((f) => f.name);
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `<img src>` in custom HTML. The HTML is rebuilt from the allowlist first, so
 * every attribute is in the one canonical double-quoted form the sanitizer
 * writes — a hand-written `src='…'` cannot slip past the walker as a
 * reference nobody saw. The tree is sanitized again on apply in any case.
 */
function mapHtmlImages(html: string, where: string, fn: ImageMapper): string {
  const clean = sanitizeHtml(html);
  return clean.replace(/<img\b[^>]*>/g, (tag) =>
    tag.replace(/\bsrc="([^"]*)"/, (_m, raw: string) => `src="${escapeAttr(fn(unescapeAttr(raw), { place: "html", where }))}"`),
  );
}

/** `url()` in theme CSS — the same pattern `cssProblems` checks. */
function mapCssImages(css: string, fn: ImageMapper): string {
  return css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, quote: string, raw: string) => {
    const url = raw.trim();
    if (!url) return whole;
    const next = fn(url, { place: "css", where: "theme CSS" });
    return next === url ? whole : `url(${quote}${next}${quote})`;
  });
}

function mapTree<T extends TreeLike>(node: T, where: string, fn: ImageMapper): T {
  const props = node.props ? { ...node.props } : undefined;
  if (props) {
    const at = `${where} › ${node.type}${node.id ? ` ${node.id}` : ""}`;
    for (const name of imageProps(node.type)) {
      const v = props[name];
      if (typeof v === "string" && v) props[name] = fn(v, { place: "block", where: at });
    }
    if (node.type === "html" && typeof props.html === "string" && props.html) {
      props.html = mapHtmlImages(props.html, at, fn);
    }
  }
  const out = { ...node } as T;
  if (props) out.props = props;
  if (node.children) out.children = node.children.map((c) => mapTree(c, where, fn));
  return out;
}

/**
 * Visit every image reference in a package, in all four places, and return
 * the package with each replaced by what `fn` returns. Works on both the
 * applied form and the file form, which differ only in what an image string
 * may hold.
 */
export function mapImages<P extends Pick<ThemePackage, "theme" | "documents" | "savedBlocks">>(pkg: P, fn: ImageMapper): P {
  return {
    ...pkg,
    theme: { ...pkg.theme, customCss: mapCssImages(pkg.theme.customCss ?? "", fn) },
    documents: pkg.documents.map((d) => {
      const where = d.kind === "page" ? `page "${d.handle}"` : `${d.kind} "${d.handle}"`;
      const seo = { ...(d.seo ?? {}) } as PageSeo;
      if (seo.ogImage) seo.ogImage = fn(seo.ogImage, { place: "seo", where: `${where} › link preview` });
      return { ...d, seo, tree: mapTree(d.tree as TreeLike, where, fn) };
    }),
    savedBlocks: pkg.savedBlocks.map((b) => ({ ...b, node: mapTree(b.node as TreeLike, `saved block "${b.name}"`, fn) })),
  } as P;
}

/** Every image reference in a package, in walk order. Duplicates are kept — each is a place to fix. */
export function imageRefs(pkg: Pick<ThemePackage, "theme" | "documents" | "savedBlocks">): ImageRef[] {
  const refs: ImageRef[] = [];
  mapImages(pkg, (url, ref) => {
    refs.push({ url, ...ref });
    return url;
  });
  return refs;
}
