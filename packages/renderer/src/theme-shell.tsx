import type { CSSProperties, ReactNode } from "react";
import { BLOCK_CSS } from "./block-css";
import { themeStylesheet, type ThemeId, type ThemeTokens } from "./themes";

/**
 * What every storefront page sits inside: the theme's fonts and stylesheet,
 * the block CSS once (before any document's node styles), and the shell whose
 * CSS variables the blocks read. Markii's `ThemeRoot` is this plus the builder
 * preview's bridge; an exported store uses it as it is (D53).
 */

function themeStyle(t: ThemeTokens): CSSProperties {
  return {
    ["--sf-bg" as string]: t.background,
    ["--sf-surface" as string]: t.surface,
    ["--sf-fg" as string]: t.foreground,
    ["--sf-muted" as string]: t.muted,
    ["--sf-border" as string]: t.border,
    ["--sf-accent" as string]: t.accent,
    ["--sf-accent-text" as string]: t.accentText,
    ["--sf-font-body" as string]: t.fontBody,
    ["--sf-font-display" as string]: t.fontDisplay,
    ["--sf-radius" as string]: t.radius,
    ["--sf-max" as string]: t.maxWidth,
    ["--sf-card-pad" as string]: t.cardPad,
    ["--sf-grid-min" as string]: t.gridMin,
    ["--sf-image-aspect" as string]: t.imageAspect,
    ["--sf-grid-gap" as string]: t.gridGap,
    background: t.background,
    color: t.foreground,
    fontFamily: t.fontBody,
    minHeight: "100vh",
  };
}

export function ThemeShell({ theme, children }: { theme: ThemeTokens; children: ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={theme.fontHref} />
      <style dangerouslySetInnerHTML={{ __html: themeStylesheet(theme) }} />
      {/* Once per page, after the theme and before any builder document's node styles (`./block-css`). */}
      <style dangerouslySetInnerHTML={{ __html: BLOCK_CSS }} />
      <div className="sf-shell" data-theme={theme.id as ThemeId} style={themeStyle(theme)}>
        {children}
      </div>
    </>
  );
}
