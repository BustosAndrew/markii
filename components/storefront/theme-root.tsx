import type { CSSProperties, ReactNode } from "react";
import { getTheme, type ThemeId } from "@/lib/storefront/themes";

function themeStyle(themeId?: string | null): CSSProperties {
  const t = getTheme(themeId);
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
    background: t.background,
    color: t.foreground,
    fontFamily: t.fontBody,
    minHeight: "100vh",
  };
}

export function ThemeRoot({
  themeId,
  children,
}: {
  themeId?: string | null;
  children: ReactNode;
}) {
  const theme = getTheme(themeId);
  return (
    <div
      className="sf-shell"
      data-theme={theme.id as ThemeId}
      style={themeStyle(themeId)}
    >
      {children}
    </div>
  );
}
