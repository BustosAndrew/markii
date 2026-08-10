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
  /** Google Fonts stylesheet URL — loaded by ThemeRoot / generator HTML. */
  fontHref: string;
  radius: string;
  maxWidth: string;
  cardPad: string;
  gridMin: string;
  /** Product card image aspect ratio, e.g. "4/3" or "1/1". */
  imageAspect: string;
  gridGap: string;
};

export const THEMES: Record<ThemeId, ThemeTokens> = {
  studio: {
    id: "studio",
    label: "Studio",
    description: "Editorial magazine layout, generous whitespace",
    background: "#FAFAF8",
    surface: "#FFFFFF",
    foreground: "#1A1A18",
    muted: "#6B6B66",
    border: "#E6E4DF",
    accent: "#1A1A18",
    accentText: "#FAFAF8",
    fontBody: '"Source Serif 4", "Iowan Old Style", Georgia, serif',
    fontDisplay: '"Newsreader", "Source Serif 4", Georgia, serif',
    fontHref:
      "https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600;6..72,700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap",
    radius: "2px",
    maxWidth: "780px",
    cardPad: "1.75rem",
    gridMin: "280px",
    imageAspect: "5/4",
    gridGap: "2rem",
  },
  atlas: {
    id: "atlas",
    label: "Atlas",
    description: "Dense catalog utility grid",
    background: "#F4F5F7",
    surface: "#FFFFFF",
    foreground: "#111827",
    muted: "#6B7280",
    border: "#D1D5DB",
    accent: "#111827",
    accentText: "#FFFFFF",
    fontBody: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
    fontDisplay: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
    fontHref:
      "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap",
    radius: "4px",
    maxWidth: "1100px",
    cardPad: "0.75rem",
    gridMin: "160px",
    imageAspect: "1/1",
    gridGap: "0.75rem",
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
    fontBody: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
    fontDisplay: '"Syne", "DM Sans", sans-serif',
    fontHref:
      "https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Syne:wght@500;600;700&display=swap",
    radius: "0px",
    maxWidth: "1040px",
    cardPad: "0",
    gridMin: "300px",
    imageAspect: "3/4",
    gridGap: "1.5rem",
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
    fontBody: '"Nunito Sans", ui-rounded, system-ui, sans-serif',
    fontDisplay: '"Literata", "Nunito Sans", Georgia, serif',
    fontHref:
      "https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,500;7..72,600;7..72,700&family=Nunito+Sans:opsz,wght@6..12,400;6..12,600;6..12,700&display=swap",
    radius: "16px",
    maxWidth: "960px",
    cardPad: "1.25rem",
    gridMin: "220px",
    imageAspect: "4/3",
    gridGap: "1.25rem",
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
    `--sf-image-aspect:${theme.imageAspect}`,
    `--sf-grid-gap:${theme.gridGap}`,
  ].join(";");
}

/**
 * Single source of truth for storefront chrome.
 * Used by ThemeRoot (`<style>`) and the create-site HTML preview.
 */
export function themeStylesheet(theme: ThemeTokens): string {
  return `
:root{${themeCssVars(theme)}}
*{box-sizing:border-box}
.sf-shell,.sf-shell *{box-sizing:border-box}
.sf-shell{min-height:100vh;background:var(--sf-bg);color:var(--sf-fg);font-family:var(--sf-font-body);line-height:1.55}
.sf-shell a{color:inherit}
.sf-header{border-bottom:1px solid var(--sf-border);padding:1rem 1.25rem}
.sf-header-inner{max-width:var(--sf-max);margin:0 auto;display:flex;flex-wrap:wrap;align-items:baseline;gap:1rem 1.5rem}
.sf-brand{font-family:var(--sf-font-display);font-weight:700;font-size:1.35rem;text-decoration:none;letter-spacing:-0.02em}
.sf-nav{display:flex;flex-wrap:wrap;gap:.75rem 1rem;font-size:.9rem;color:var(--sf-muted);flex:1}
.sf-nav a{text-decoration:none}
.sf-nav a:hover{color:var(--sf-fg)}
.sf-header-actions{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1rem}
.sf-cart-link{font-size:.9rem;font-weight:600;text-decoration:none;color:var(--sf-fg)}
.sf-cart-link:hover{color:var(--sf-accent)}
.sf-main{max-width:var(--sf-max);margin:0 auto;padding:2rem 1.25rem 4rem}
.sf-hero{margin:0 0 2rem}
.sf-title{font-family:var(--sf-font-display);font-size:clamp(1.75rem,4vw,2.75rem);font-weight:600;letter-spacing:-0.03em;line-height:1.15;margin:0 0 .75rem}
.sf-lede{color:var(--sf-muted);max-width:36rem;margin:0 0 0}
.sf-lede a{text-decoration:underline;text-underline-offset:2px}
.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--sf-grid-min),1fr));gap:var(--sf-grid-gap);list-style:none;padding:0;margin:0}
.sf-card{display:block;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:var(--sf-radius);padding:var(--sf-card-pad);text-decoration:none;color:inherit;height:100%}
.sf-card img{display:block;width:100%;aspect-ratio:var(--sf-image-aspect);object-fit:cover;border-radius:calc(var(--sf-radius) * .5);margin-bottom:.75rem;background:var(--sf-border)}
.sf-card h2{font-family:var(--sf-font-display);font-size:1.05rem;font-weight:600;margin:0 0 .35rem;letter-spacing:-0.02em}
.sf-price{font-weight:700;font-variant-numeric:tabular-nums}
.sf-muted{color:var(--sf-muted);font-size:.875rem}
.sf-crumb{font-size:.875rem;color:var(--sf-muted);margin:0 0 1rem}
.sf-crumb a{color:inherit}
.sf-product{display:block}
.sf-product-media{display:grid;gap:.5rem;margin:0 0 1.5rem}
.sf-product-media img{max-width:100%;width:100%;border-radius:var(--sf-radius);background:var(--sf-border);display:block}
.sf-product-body{min-width:0}
.sf-buy{background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:var(--sf-radius);padding:1rem;overflow-x:auto;font-family:ui-monospace,monospace;font-size:.8rem;margin:1rem 0}
.sf-btn{display:inline-block;background:var(--sf-accent);color:var(--sf-accent-text);padding:.65rem 1.1rem;border-radius:var(--sf-radius);text-decoration:none;font-weight:600;font-size:.9rem;border:none;cursor:pointer;font-family:inherit}
.sf-list{list-style:none;padding:0;margin:1rem 0 0}
.sf-list li{border-bottom:1px solid var(--sf-border);padding:.85rem 0;display:flex;flex-wrap:wrap;gap:.5rem 1rem;justify-content:space-between;align-items:baseline}
.sf-gate{margin:1rem 0;padding:.75rem 1rem;border:1px solid var(--sf-border);border-radius:var(--sf-radius);font-size:.9375rem}
.sf-gate-locked{border-style:dashed}
.sf-form{display:grid;gap:.75rem;max-width:22rem;margin:1rem 0 2rem}
.sf-form input{padding:.625rem .75rem;border:1px solid var(--sf-border);border-radius:var(--sf-radius);font:inherit;background:var(--sf-surface);color:var(--sf-fg)}
.sf-form button{padding:.625rem 1rem;border:0;border-radius:var(--sf-radius);font:inherit;font-weight:600;cursor:pointer;background:var(--sf-accent);color:var(--sf-accent-text)}

/* —— Studio: editorial magazine —— */
[data-theme="studio"] .sf-header{border-bottom-width:1px;padding:1.5rem 1.25rem}
[data-theme="studio"] .sf-header-inner{align-items:center}
[data-theme="studio"] .sf-brand{font-size:1.15rem;font-weight:600;letter-spacing:.02em}
[data-theme="studio"] .sf-nav{gap:1.25rem 1.75rem;font-size:.85rem;letter-spacing:.04em}
[data-theme="studio"] .sf-main{padding:3.5rem 1.5rem 5rem}
[data-theme="studio"] .sf-hero{margin-bottom:3rem;padding-bottom:2rem;border-bottom:1px solid var(--sf-border)}
[data-theme="studio"] .sf-title{font-size:clamp(2.25rem,5vw,3.5rem);font-weight:500;letter-spacing:-0.04em;max-width:14ch}
[data-theme="studio"] .sf-lede{font-size:1.125rem;line-height:1.65;max-width:28rem}
[data-theme="studio"] .sf-grid{gap:2.5rem 2rem}
[data-theme="studio"] .sf-card{border:0;border-bottom:1px solid var(--sf-border);border-radius:0;background:transparent;padding:0 0 1.5rem}
[data-theme="studio"] .sf-card img{border-radius:0;margin-bottom:1.25rem;aspect-ratio:5/4}
[data-theme="studio"] .sf-card h2{font-size:1.35rem;font-weight:500}
[data-theme="studio"] .sf-product-media img{border-radius:0}
[data-theme="studio"] .sf-product-body{max-width:36rem}

/* —— Atlas: dense utility catalog —— */
[data-theme="atlas"] .sf-header{padding:.75rem 1rem;background:var(--sf-surface)}
[data-theme="atlas"] .sf-brand{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.95rem;text-transform:uppercase;letter-spacing:.08em;font-weight:500}
[data-theme="atlas"] .sf-nav{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;gap:.5rem 1rem}
[data-theme="atlas"] .sf-cart-link{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em}
[data-theme="atlas"] .sf-main{padding:1.25rem 1rem 3rem}
[data-theme="atlas"] .sf-hero{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.75rem 2rem;margin-bottom:1.25rem;padding:.75rem 0;border-top:2px solid var(--sf-fg);border-bottom:1px solid var(--sf-border)}
[data-theme="atlas"] .sf-title{font-size:1.15rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin:0;font-family:"IBM Plex Mono",ui-monospace,monospace}
[data-theme="atlas"] .sf-lede{font-size:.8rem;max-width:none;margin:0}
[data-theme="atlas"] .sf-grid{gap:.75rem}
[data-theme="atlas"] .sf-card{padding:.75rem;box-shadow:none}
[data-theme="atlas"] .sf-card img{aspect-ratio:1/1;border-radius:2px;margin-bottom:.5rem}
[data-theme="atlas"] .sf-card h2{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;font-weight:500}
[data-theme="atlas"] .sf-price{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.85rem;font-weight:500}
[data-theme="atlas"] .sf-muted{font-size:.75rem}
[data-theme="atlas"] .sf-product{display:grid;gap:1.5rem;align-items:start}
@media (min-width:720px){
  [data-theme="atlas"] .sf-product{grid-template-columns:1fr 1fr;gap:2rem}
  [data-theme="atlas"] .sf-product-media{margin:0}
}

/* —— Noir: dark portfolio —— */
[data-theme="noir"] .sf-header{border-bottom:1px solid var(--sf-border);padding:1.25rem 1.5rem;position:sticky;top:0;background:rgba(12,12,14,.92);z-index:10}
[data-theme="noir"] .sf-brand{font-size:1.1rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
[data-theme="noir"] .sf-nav{justify-content:flex-end;gap:1.5rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.14em}
[data-theme="noir"] .sf-cart-link{font-size:.75rem;text-transform:uppercase;letter-spacing:.14em}
[data-theme="noir"] .sf-main{padding:0 0 4rem;max-width:none}
[data-theme="noir"] .sf-hero{max-width:none;margin:0;padding:clamp(3rem,12vw,7rem) 1.5rem;border-bottom:1px solid var(--sf-border);background:linear-gradient(180deg,var(--sf-surface) 0%,var(--sf-bg) 100%)}
[data-theme="noir"] .sf-hero .sf-title,[data-theme="noir"] .sf-hero .sf-lede{max-width:var(--sf-max);margin-left:auto;margin-right:auto}
[data-theme="noir"] .sf-title{font-size:clamp(2.5rem,8vw,4.5rem);font-weight:700;letter-spacing:-0.04em;text-transform:uppercase;line-height:1.05}
[data-theme="noir"] .sf-lede{font-size:1rem;max-width:28rem;margin-top:1.25rem}
[data-theme="noir"] .sf-grid{max-width:var(--sf-max);margin:2.5rem auto 0;padding:0 1.5rem;gap:2rem 1.5rem}
[data-theme="noir"] .sf-card{background:transparent;border:0;padding:0}
[data-theme="noir"] .sf-card img{border-radius:0;margin-bottom:1rem;aspect-ratio:3/4}
[data-theme="noir"] .sf-card h2{font-size:1rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
[data-theme="noir"] .sf-crumb,[data-theme="noir"] .sf-product,[data-theme="noir"] .sf-list,[data-theme="noir"] .sf-form,[data-theme="noir"] .sf-gate{max-width:var(--sf-max);margin-left:auto;margin-right:auto;padding-left:1.5rem;padding-right:1.5rem}
[data-theme="noir"] .sf-product{padding-top:2rem}
[data-theme="noir"] .sf-product-media{margin:0 -1.5rem 2rem;gap:0}
[data-theme="noir"] .sf-product-media img{border-radius:0;width:100%;max-height:70vh;object-fit:cover}
[data-theme="noir"] .sf-product-body{max-width:36rem}
[data-theme="noir"] .sf-btn{border-radius:0;letter-spacing:.08em;text-transform:uppercase;font-size:.8rem}

/* —— Bloom: soft creator shop —— */
[data-theme="bloom"] .sf-header{border:0;padding:1.25rem 1.5rem}
[data-theme="bloom"] .sf-header-inner{align-items:center}
[data-theme="bloom"] .sf-brand{font-size:1.5rem;font-weight:600;letter-spacing:-0.02em}
[data-theme="bloom"] .sf-nav{gap:1rem 1.25rem;font-size:.95rem}
[data-theme="bloom"] .sf-cart-link{background:var(--sf-accent);color:var(--sf-accent-text);padding:.45rem 1rem;border-radius:999px;font-size:.85rem}
[data-theme="bloom"] .sf-cart-link:hover{opacity:.92;color:var(--sf-accent-text)}
[data-theme="bloom"] .sf-main{padding:2rem 1.5rem 4.5rem}
[data-theme="bloom"] .sf-hero{margin-bottom:2.5rem;padding:1.75rem 1.5rem 1.5rem;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:calc(var(--sf-radius) + 4px);box-shadow:0 8px 24px rgba(44,24,16,.04)}
[data-theme="bloom"] .sf-title{font-size:clamp(2rem,4.5vw,3rem);font-weight:600;letter-spacing:-0.02em}
[data-theme="bloom"] .sf-title::after{content:"";display:block;width:3rem;height:3px;margin-top:.85rem;background:var(--sf-accent);border-radius:2px}
[data-theme="bloom"] .sf-lede{font-size:1.05rem;max-width:32rem}
[data-theme="bloom"] .sf-grid{gap:1.25rem}
[data-theme="bloom"] .sf-card{box-shadow:0 4px 16px rgba(44,24,16,.05)}
[data-theme="bloom"] .sf-card img{border-radius:calc(var(--sf-radius) - 4px)}
[data-theme="bloom"] .sf-card h2{font-size:1.1rem;font-weight:600}
[data-theme="bloom"] .sf-price{display:inline-block;margin-top:.35rem;padding:.2rem .65rem;background:var(--sf-bg);border-radius:999px;font-size:.9rem;color:var(--sf-accent)}
[data-theme="bloom"] .sf-btn,[data-theme="bloom"] .sf-form button{border-radius:999px}
[data-theme="bloom"] .sf-product-media img{border-radius:var(--sf-radius)}
[data-theme="bloom"] .sf-gate{border-radius:var(--sf-radius)}
`.trim();
}

/** Standalone HTML documents (wizard preview) also need body reset. */
export function themeDocumentStylesheet(theme: ThemeTokens): string {
  return `
*{box-sizing:border-box}
body{margin:0;background:var(--sf-bg);color:var(--sf-fg);font-family:var(--sf-font-body);line-height:1.55}
${themeStylesheet(theme)}
`.trim();
}
