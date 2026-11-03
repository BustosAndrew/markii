/**
 * The site builder's document model (`docs/BUILDER.md` §4, D51).
 *
 * A page is a **JSON node tree, never an HTML string**. HTML is a render
 * target, which is what lets one document render on the storefront, in the
 * editor's live preview, and as a diff an agent or a person can read.
 *
 * Everything here is plain data with no server or client dependency, so the
 * dashboard, the renderer, the registry actions and the unit tests all share
 * one definition.
 */

export const BREAKPOINTS = ["base", "sm", "md", "lg"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Min-widths for the mobile-first overrides. `base` applies everywhere. */
export const BREAKPOINT_MIN_WIDTH: Record<Exclude<Breakpoint, "base">, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
};

/**
 * Style properties a node may set. **Token names, never raw CSS** — an agent
 * adjusting spacing picks from a scale, so it cannot produce the drift that
 * arbitrary pixel values invite (`docs/BUILDER.md` §7). Validated by
 * `styleSchema` in `./styles`.
 */
export type StyleProps = {
  paddingY?: SpaceToken;
  paddingX?: SpaceToken;
  marginTop?: SpaceToken;
  marginBottom?: SpaceToken;
  gap?: SpaceToken;
  align?: "start" | "center" | "end";
  width?: "content" | "wide" | "full";
  background?: ColorToken | "none";
  color?: ColorToken;
  fontSize?: FontSizeToken;
  font?: "body" | "display";
  radius?: "none" | "theme" | "full";
  border?: boolean;
  columns?: 1 | 2 | 3 | 4 | 5 | 6;
  hidden?: boolean;
};

export const SPACE_TOKENS = ["0", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"] as const;
export type SpaceToken = (typeof SPACE_TOKENS)[number];

export const COLOR_TOKENS = ["bg", "surface", "fg", "muted", "border", "accent", "accentText"] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export const FONT_SIZE_TOKENS = ["sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] as const;
export type FontSizeToken = (typeof FONT_SIZE_TOKENS)[number];

export type NodeStyles = Partial<Record<Breakpoint, StyleProps>>;

export type PageNode = {
  /** `n_` + 10 lowercase base-36 characters — also the node's CSS class, so it must stay safe there. */
  id: string;
  /** A block type from the registry (`./blocks`). */
  type: string;
  /** Validated by the block's own schema. */
  props: Record<string, unknown>;
  styles?: NodeStyles;
  children?: PageNode[];
  /**
   * A human- or agent-written note about what the node is for — "hero, above
   * the fold". Never shown to shoppers. Small, but it is the semantic context
   * an agent (and a returning merchant) would otherwise have to reconstruct
   * from raw structure.
   */
  intent?: string;
  /**
   * Props filled from live data at render (`docs/BUILDER.md` §9): prop name →
   * a path from `./bindings`, such as `{ text: "product.title" }`. The prop's
   * own value stays as the design-time placeholder and shows wherever the data
   * is not available.
   */
  bindings?: Record<string, string>;
  /** Render only when this holds — a whitelisted comparison, never an expression to evaluate. */
  visibleWhen?: Condition;
};

export const CONDITION_OPS = ["exists", "missing", "eq", "neq", "gt", "gte", "lt", "lte"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export type Condition = { path: string; op: ConditionOp; value?: string | number | boolean };

export const NODE_ID_PATTERN = /^n_[a-z0-9]{10}$/;

/** Hard limits, enforced in `./tree` on every write. */
export const TREE_LIMITS = {
  maxNodes: 500,
  maxDepth: 12,
  /** Serialized props of one node. Long copy belongs in several blocks. */
  maxPropsBytes: 20_000,
  maxIntentLength: 200,
} as const;

export const DOCUMENT_KINDS = ["page", "template", "region"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Templates (M4): the layout every product or collection page renders with,
 * once customised. A store with none keeps the fixed layout for that page type.
 */
export const TEMPLATE_HANDLES = ["product", "collection"] as const;
export type TemplateHandle = (typeof TEMPLATE_HANDLES)[number];

/** Global regions (M4): edited once, shown on every storefront page. */
export const REGION_HANDLES = ["announcement", "header", "footer"] as const;
export type RegionHandle = (typeof REGION_HANDLES)[number];

export const SHARED_DOCUMENT_TITLES: Record<TemplateHandle | RegionHandle, string> = {
  product: "Product page",
  collection: "Collection page",
  announcement: "Announcement bar",
  header: "Header",
  footer: "Footer",
};

export type PageSeo = {
  title?: string;
  description?: string;
  noindex?: boolean;
};

/** The home page always exists and keeps this handle. */
export const HOME_HANDLE = "home";
