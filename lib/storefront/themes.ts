import type { ThemeId } from "@/lib/api/types";

export type { ThemeId };

export type ThemeTokens = {
  id: ThemeId;
  label: string;
  description: string;
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  fontBody: string;
  fontDisplay: string;
  radius: string;
  maxWidth: string;
  cardPad: string;
  gridMin: string;
};

export const THEMES: Record<ThemeId, ThemeTokens> = {
  studio: {
    id: "studio",
    label: "Studio",
    description: "Editorial serif, generous whitespace",
    background: "#FAFAF8",
    surface: "#FFFFFF",
    foreground: "#1A1A18",
    muted: "#6B6B66",
    border: "#E6E4DF",
    accent: "#1A1A18",
    accentText: "#FAFAF8",
    fontBody: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
    fontDisplay: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
    radius: "2px",
    maxWidth: "920px",
    cardPad: "1.5rem",
    gridMin: "240px",
  },
  atlas: {
    id: "atlas",
    label: "Atlas",
    description: "Dense catalog, utility grid, mono accents",
    background: "#F4F5F7",
    surface: "#FFFFFF",
    foreground: "#111827",
    muted: "#6B7280",
    border: "#D1D5DB",
    accent: "#111827",
    accentText: "#FFFFFF",
    fontBody: 'ui-sans-serif, system-ui, sans-serif',
    fontDisplay: 'ui-sans-serif, system-ui, sans-serif',
    radius: "4px",
    maxWidth: "1100px",
    cardPad: "0.875rem",
    gridMin: "180px",
  },
  noir: {
    id: "noir",
    label: "Noir",
    description: "Dark high-contrast portfolio",
    background: "#0C0C0E",
    surface: "#16161A",
    foreground: "#F4F4F5",
    muted: "#A1A1AA",
    border: "#27272A",
    accent: "#F4F4F5",
    accentText: "#0C0C0E",
    fontBody: 'ui-sans-serif, system-ui, sans-serif',
    fontDisplay: 'ui-sans-serif, system-ui, sans-serif',
    radius: "0px",
    maxWidth: "960px",
    cardPad: "1.25rem",
    gridMin: "220px",
  },
  bloom: {
    id: "bloom",
    label: "Bloom",
    description: "Warm soft creator shop",
    background: "#FFF8F3",
    surface: "#FFFFFF",
    foreground: "#2C1810",
    muted: "#8A6A5A",
    border: "#F0DDD0",
    accent: "#C45C26",
    accentText: "#FFF8F3",
    fontBody: 'ui-rounded, "Segoe UI", system-ui, sans-serif',
    fontDisplay: 'ui-rounded, "Segoe UI", system-ui, sans-serif',
    radius: "16px",
    maxWidth: "960px",
    cardPad: "1.25rem",
    gridMin: "220px",
  },
};

export function resolveThemeId(raw: string | null | undefined): ThemeId {
  if (raw === "studio" || raw === "atlas" || raw === "noir" || raw === "bloom") {
    return raw;
  }
  return "studio";
}

export function getTheme(id: string | null | undefined): ThemeTokens {
  return THEMES[resolveThemeId(id)];
}

/** CSS custom properties for ThemeRoot and generator HTML. */
export function themeCssVars(theme: ThemeTokens): string {
  return [
    `--sf-bg:${theme.background}`,
    `--sf-surface:${theme.surface}`,
    `--sf-fg:${theme.foreground}`,
    `--sf-muted:${theme.muted}`,
    `--sf-border:${theme.border}`,
    `--sf-accent:${theme.accent}`,
    `--sf-accent-text:${theme.accentText}`,
    `--sf-font-body:${theme.fontBody}`,
    `--sf-font-display:${theme.fontDisplay}`,
    `--sf-radius:${theme.radius}`,
    `--sf-max:${theme.maxWidth}`,
    `--sf-card-pad:${theme.cardPad}`,
    `--sf-grid-min:${theme.gridMin}`,
  ].join(";");
}

export function themeStylesheet(theme: ThemeTokens): string {
  return `
:root{${themeCssVars(theme)}}
*{box-sizing:border-box}
body{margin:0;background:var(--sf-bg);color:var(--sf-fg);font-family:var(--sf-font-body);line-height:1.55}
a{color:inherit}
.sf-shell{min-height:100vh;background:var(--sf-bg);color:var(--sf-fg)}
.sf-header{border-bottom:1px solid var(--sf-border);padding:1rem 1.25rem}
.sf-header-inner{max-width:var(--sf-max);margin:0 auto;display:flex;flex-wrap:wrap;align-items:baseline;gap:1rem 1.5rem}
.sf-brand{font-family:var(--sf-font-display);font-weight:700;font-size:1.35rem;text-decoration:none;letter-spacing:-0.02em}
.sf-nav{display:flex;flex-wrap:wrap;gap:.75rem 1rem;font-size:.9rem;color:var(--sf-muted)}
.sf-nav a{text-decoration:none}
.sf-nav a:hover{color:var(--sf-fg)}
.sf-main{max-width:var(--sf-max);margin:0 auto;padding:2rem 1.25rem 4rem}
.sf-title{font-family:var(--sf-font-display);font-size:clamp(1.75rem,4vw,2.75rem);font-weight:600;letter-spacing:-0.03em;line-height:1.15;margin:0 0 .75rem}
.sf-lede{color:var(--sf-muted);max-width:36rem;margin:0 0 1.5rem}
.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--sf-grid-min),1fr));gap:1rem;list-style:none;padding:0;margin:1.5rem 0 0}
.sf-card{display:block;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:var(--sf-radius);padding:var(--sf-card-pad);text-decoration:none;color:inherit;height:100%}
.sf-card img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:calc(var(--sf-radius) * .5);margin-bottom:.75rem;background:var(--sf-border)}
.sf-card h2{font-family:var(--sf-font-display);font-size:1.05rem;font-weight:600;margin:0 0 .35rem;letter-spacing:-0.02em}
.sf-price{font-weight:700;font-variant-numeric:tabular-nums}
.sf-muted{color:var(--sf-muted);font-size:.875rem}
.sf-crumb{font-size:.875rem;color:var(--sf-muted);margin:0 0 1rem}
.sf-crumb a{color:inherit}
.sf-product-media{display:grid;gap:.5rem;margin:1rem 0 1.5rem}
.sf-product-media img{max-width:100%;border-radius:var(--sf-radius);background:var(--sf-border)}
.sf-buy{background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:var(--sf-radius);padding:1rem;overflow-x:auto;font-family:ui-monospace,monospace;font-size:.8rem;margin:1rem 0}
.sf-btn{display:inline-block;background:var(--sf-accent);color:var(--sf-accent-text);padding:.65rem 1.1rem;border-radius:var(--sf-radius);text-decoration:none;font-weight:600;font-size:.9rem;border:none}
.sf-list{list-style:none;padding:0;margin:1rem 0 0}
.sf-list li{border-bottom:1px solid var(--sf-border);padding:.85rem 0;display:flex;flex-wrap:wrap;gap:.5rem 1rem;justify-content:space-between;align-items:baseline}
[data-theme="atlas"] .sf-card h2{font-family:ui-monospace,monospace;font-size:.9rem;text-transform:uppercase;letter-spacing:.04em}
[data-theme="atlas"] .sf-price{font-family:ui-monospace,monospace}
[data-theme="studio"] .sf-main{padding-top:3rem}
[data-theme="noir"] .sf-card{background:transparent}
[data-theme="bloom"] .sf-btn{border-radius:999px}
`.trim();
}
