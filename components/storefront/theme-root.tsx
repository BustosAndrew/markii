import type { CSSProperties, ReactNode } from "react";
import {
  getTheme,
  themeStylesheet,
  type ThemeId,
  type ThemeTokens,
} from "@/lib/storefront/themes";

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

export function ThemeRoot({
  themeId,
  theme: resolved,
  children,
}: {
  themeId?: string | null;
  /**
   * The site's published theme with its design-token overrides applied
   * (`loadSite` → `data.theme`, D51). Wins over `themeId` when given.
   */
  theme?: ThemeTokens;
  children: ReactNode;
}) {
  const theme = resolved ?? getTheme(themeId);
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={theme.fontHref} />
      <style dangerouslySetInnerHTML={{ __html: themeStylesheet(theme) }} />
      <div
        className="sf-shell"
        data-theme={theme.id as ThemeId}
        style={themeStyle(theme)}
      >
        {children}
      </div>
    </>
  );
}
