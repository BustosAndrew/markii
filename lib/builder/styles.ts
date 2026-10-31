import { z } from "zod";
import {
  BREAKPOINT_MIN_WIDTH,
  BREAKPOINTS,
  COLOR_TOKENS,
  FONT_SIZE_TOKENS,
  SPACE_TOKENS,
  type Breakpoint,
  type ColorToken,
  type FontSizeToken,
  type NodeStyles,
  type PageNode,
  type SpaceToken,
  type StyleProps,
} from "./types";

/**
 * Token-driven node styles (`docs/BUILDER.md` §7).
 *
 * A node's styles are token names; this module is the only place they become
 * CSS. The output is **one stylesheet of per-node classes** (`.mk-{id}`), not
 * inline styles and not runtime CSS-in-JS — the storefront ships zero builder
 * JavaScript, and a published page's CSS is plain text in its HTML.
 */

export const styleSchema = z
  .object({
    paddingY: z.enum(SPACE_TOKENS),
    paddingX: z.enum(SPACE_TOKENS),
    marginTop: z.enum(SPACE_TOKENS),
    marginBottom: z.enum(SPACE_TOKENS),
    gap: z.enum(SPACE_TOKENS),
    align: z.enum(["start", "center", "end"]),
    width: z.enum(["content", "wide", "full"]),
    background: z.enum([...COLOR_TOKENS, "none"]),
    color: z.enum(COLOR_TOKENS),
    fontSize: z.enum(FONT_SIZE_TOKENS),
    font: z.enum(["body", "display"]),
    radius: z.enum(["none", "theme", "full"]),
    border: z.boolean(),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
    hidden: z.boolean(),
  })
  .partial()
  .strict();

export const nodeStylesSchema = z
  .object(Object.fromEntries(BREAKPOINTS.map((b) => [b, styleSchema.optional()])) as Record<
    Breakpoint,
    z.ZodOptional<typeof styleSchema>
  >)
  .strict();

const SPACE: Record<SpaceToken, string> = {
  "0": "0",
  xs: ".25rem",
  sm: ".5rem",
  md: "1rem",
  lg: "1.5rem",
  xl: "2.5rem",
  "2xl": "4rem",
  "3xl": "6rem",
};

const COLOR: Record<ColorToken, string> = {
  bg: "var(--sf-bg)",
  surface: "var(--sf-surface)",
  fg: "var(--sf-fg)",
  muted: "var(--sf-muted)",
  border: "var(--sf-border)",
  accent: "var(--sf-accent)",
  accentText: "var(--sf-accent-text)",
};

/** The readable text colour on each background token, used when a node sets a background but no colour. */
const TEXT_ON: Partial<Record<ColorToken, ColorToken>> = {
  accent: "accentText",
  fg: "bg",
  accentText: "accent",
};

const FONT_SIZE: Record<FontSizeToken, string> = {
  sm: ".875rem",
  md: "1rem",
  lg: "1.25rem",
  xl: "1.5rem",
  "2xl": "2rem",
  "3xl": "2.75rem",
  "4xl": "3.5rem",
};

const ALIGN = { start: "left", center: "center", end: "right" } as const;

/** One breakpoint's declarations for one node. Pure; exported for tests. */
export function declarations(s: StyleProps): string[] {
  const out: string[] = [];
  if (s.paddingY) out.push(`padding-top:${SPACE[s.paddingY]}`, `padding-bottom:${SPACE[s.paddingY]}`);
  if (s.paddingX) out.push(`padding-left:${SPACE[s.paddingX]}`, `padding-right:${SPACE[s.paddingX]}`);
  if (s.marginTop) out.push(`margin-top:${SPACE[s.marginTop]}`);
  if (s.marginBottom) out.push(`margin-bottom:${SPACE[s.marginBottom]}`);
  if (s.gap) out.push(`gap:${SPACE[s.gap]}`);
  if (s.align) out.push(`text-align:${ALIGN[s.align]}`, `justify-items:${s.align}`);
  if (s.width === "content") out.push("max-width:var(--sf-max)", "margin-left:auto", "margin-right:auto");
  if (s.width === "wide") out.push("max-width:1200px", "margin-left:auto", "margin-right:auto");
  if (s.width === "full") out.push("max-width:none");
  if (s.background === "none") out.push("background:transparent");
  else if (s.background) {
    out.push(`background:${COLOR[s.background]}`);
    const text = TEXT_ON[s.background];
    if (text && !s.color) out.push(`color:${COLOR[text]}`);
  }
  if (s.color) out.push(`color:${COLOR[s.color]}`);
  if (s.fontSize) out.push(`font-size:${FONT_SIZE[s.fontSize]}`);
  if (s.font) out.push(`font-family:var(--sf-font-${s.font})`);
  if (s.radius) out.push(`border-radius:${s.radius === "none" ? "0" : s.radius === "full" ? "9999px" : "var(--sf-radius)"}`);
  if (s.border === true) out.push("border:1px solid var(--sf-border)");
  if (s.border === false) out.push("border:0");
  if (s.columns) out.push(`grid-template-columns:repeat(${s.columns},minmax(0,1fr))`);
  if (s.hidden === true) out.push("display:none");
  return out;
}

export function nodeClass(id: string): string {
  return `mk-${id}`;
}

function walk(node: PageNode, fn: (n: PageNode) => void) {
  fn(node);
  for (const child of node.children ?? []) walk(child, fn);
}

/**
 * The stylesheet for a whole tree, mobile-first: base rules, then one media
 * query per breakpoint that has any overrides. Node ids are validated against
 * `NODE_ID_PATTERN`, so they are safe as class names without escaping.
 */
export function compileStyles(root: PageNode): string {
  const base: string[] = [];
  const byBreakpoint: Record<Exclude<Breakpoint, "base">, string[]> = { sm: [], md: [], lg: [] };

  walk(root, (node) => {
    const styles: NodeStyles = node.styles ?? {};
    const cls = `.${nodeClass(node.id)}`;
    const b = declarations(styles.base ?? {});
    if (b.length) base.push(`${cls}{${b.join(";")}}`);
    for (const bp of ["sm", "md", "lg"] as const) {
      const d = declarations(styles[bp] ?? {});
      if (d.length) byBreakpoint[bp].push(`${cls}{${d.join(";")}}`);
    }
  });

  const media = (["sm", "md", "lg"] as const)
    .filter((bp) => byBreakpoint[bp].length > 0)
    .map((bp) => `@media (min-width:${BREAKPOINT_MIN_WIDTH[bp]}px){${byBreakpoint[bp].join("")}}`);
  return [...base, ...media].join("");
}
