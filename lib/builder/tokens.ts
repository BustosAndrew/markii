import { z } from "zod";
import { getTheme, type ThemeId, type ThemeTokens } from "@/lib/storefront/themes";

/**
 * A site's design tokens: overrides on top of one of the four themes
 * (`docs/BUILDER.md` §7, D51).
 *
 * **Closed sets, not free CSS.** Colours are hex, fonts come from a curated
 * list, radius and width from scales. That is what keeps an agent's "make it
 * feel warmer" from producing something unreadable or unloadable, and it is
 * what lets `themeCssVars` stay the one place tokens become CSS.
 */

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour, like #1A1A18.")
  .transform((v) => v.toUpperCase());

/**
 * Fonts a site may use: each a Google Fonts family Markii loads, and the CSS
 * stack it falls back through. Curated so a typo cannot ship a page in Times
 * New Roman, and so the stylesheet URL is built here rather than taken from
 * input.
 */
export const FONTS = {
  "Source Serif 4": { stack: '"Source Serif 4", Georgia, serif', family: "Source+Serif+4:opsz,wght@8..60,400;8..60,600" },
  Newsreader: { stack: '"Newsreader", Georgia, serif', family: "Newsreader:opsz,wght@6..72,500;6..72,700" },
  Inter: { stack: '"Inter", system-ui, sans-serif', family: "Inter:wght@400;500;600;700" },
  "DM Sans": { stack: '"DM Sans", system-ui, sans-serif', family: "DM+Sans:wght@400;500;700" },
  "Space Grotesk": { stack: '"Space Grotesk", system-ui, sans-serif', family: "Space+Grotesk:wght@400;500;700" },
  Fraunces: { stack: '"Fraunces", Georgia, serif', family: "Fraunces:opsz,wght@9..144,400;9..144,700" },
  "Playfair Display": { stack: '"Playfair Display", Georgia, serif', family: "Playfair+Display:wght@400;700" },
  "IBM Plex Mono": { stack: '"IBM Plex Mono", ui-monospace, monospace', family: "IBM+Plex+Mono:wght@400;600" },
  Outfit: { stack: '"Outfit", system-ui, sans-serif', family: "Outfit:wght@400;500;700" },
  Lora: { stack: '"Lora", Georgia, serif', family: "Lora:wght@400;600" },
} as const;
export type FontName = keyof typeof FONTS;
const fontName = z.enum(Object.keys(FONTS) as [FontName, ...FontName[]]);

export const RADIUS_SCALE = ["0", "2px", "6px", "12px", "20px"] as const;
export const MAX_WIDTH_SCALE = ["680px", "780px", "960px", "1120px", "1280px"] as const;

const tokenFields = {
  background: hex,
  surface: hex,
  foreground: hex,
  muted: hex,
  border: hex,
  accent: hex,
  accentText: hex,
  fontBody: fontName,
  fontDisplay: fontName,
  radius: z.enum(RADIUS_SCALE),
  maxWidth: z.enum(MAX_WIDTH_SCALE),
};

export const designTokensSchema = z.object(tokenFields).partial().strict();

export type DesignTokens = z.infer<typeof designTokensSchema>;

/** A patch: a value sets the token, `null` returns it to the theme's own. */
export const designTokensPatchSchema = z
  .object({
    background: hex.nullable(),
    surface: hex.nullable(),
    foreground: hex.nullable(),
    muted: hex.nullable(),
    border: hex.nullable(),
    accent: hex.nullable(),
    accentText: hex.nullable(),
    fontBody: fontName.nullable(),
    fontDisplay: fontName.nullable(),
    radius: z.enum(RADIUS_SCALE).nullable(),
    maxWidth: z.enum(MAX_WIDTH_SCALE).nullable(),
  })
  .partial()
  .strict();

export function applyTokenPatch(current: DesignTokens, patch: Record<string, unknown>): DesignTokens {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return designTokensSchema.parse(next);
}

/**
 * One Google Fonts URL carrying the theme's own families plus any chosen ones,
 * so overriding only the display font still loads the theme's body font.
 */
export function mergedFontHref(baseHref: string, chosen: (FontName | undefined)[]): string {
  // Raw split, not URLSearchParams, which would decode "Source+Serif+4" into spaces.
  const query = baseHref.split("?")[1] ?? "";
  const families = query
    .split("&")
    .filter((part) => part.startsWith("family="))
    .map((part) => part.slice("family=".length));
  for (const name of chosen) {
    if (name && !families.includes(FONTS[name].family)) families.push(FONTS[name].family);
  }
  // Built by hand: URLSearchParams would percent-encode the `:` `;` `@` the API expects literally.
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join("&")}&display=swap`;
}

/** The theme a storefront renders with: the base theme, overridden token by token. */
export function resolveTheme(themeId: string | null | undefined, tokens: DesignTokens | null | undefined): ThemeTokens {
  const base = getTheme(themeId);
  if (!tokens || Object.keys(tokens).length === 0) return base;
  const body = tokens.fontBody ? FONTS[tokens.fontBody].stack : base.fontBody;
  const display = tokens.fontDisplay ? FONTS[tokens.fontDisplay].stack : base.fontDisplay;
  const customFonts = Boolean(tokens.fontBody || tokens.fontDisplay);
  return {
    ...base,
    background: tokens.background ?? base.background,
    surface: tokens.surface ?? base.surface,
    foreground: tokens.foreground ?? base.foreground,
    muted: tokens.muted ?? base.muted,
    border: tokens.border ?? base.border,
    accent: tokens.accent ?? base.accent,
    accentText: tokens.accentText ?? base.accentText,
    fontBody: body,
    fontDisplay: display,
    fontHref: customFonts ? mergedFontHref(base.fontHref, [tokens.fontBody, tokens.fontDisplay]) : base.fontHref,
    radius: tokens.radius ?? base.radius,
    maxWidth: tokens.maxWidth ?? base.maxWidth,
  };
}

// ---------- contrast (WCAG 2.x) ----------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hexColor: string): number | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. Null when either colour is not a plain hex (a theme may use one). */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastWarning = { pair: string; ratio: number; minimum: number; message: string };

/**
 * Text pairs that fall short of WCAG AA. **Warnings, never refusals**
 * (`docs/BUILDER.md` §7: "warn, don't block") — a merchant may have a reason,
 * and a checker that blocks gets turned off.
 */
export function contrastWarnings(theme: ThemeTokens): ContrastWarning[] {
  const pairs: [string, string, string, number][] = [
    ["text on background", theme.foreground, theme.background, 4.5],
    ["text on cards", theme.foreground, theme.surface, 4.5],
    ["secondary text on background", theme.muted, theme.background, 4.5],
    ["button text on accent", theme.accentText, theme.accent, 4.5],
  ];
  const out: ContrastWarning[] = [];
  for (const [pair, fg, bg, minimum] of pairs) {
    const ratio = contrastRatio(fg, bg);
    if (ratio != null && ratio < minimum) {
      out.push({
        pair,
        ratio: Math.round(ratio * 100) / 100,
        minimum,
        message: `${pair[0].toUpperCase()}${pair.slice(1)} has a contrast of ${ratio.toFixed(2)}:1; WCAG AA asks for ${minimum}:1.`,
      });
    }
  }
  return out;
}

export type { ThemeId };
