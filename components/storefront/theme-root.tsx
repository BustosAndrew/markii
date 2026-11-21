import type { ReactNode } from "react";
import { ThemeShell } from "@markii/renderer/theme-shell";
import { getTheme, type ThemeTokens } from "@markii/renderer/themes";
import { PreviewBridge } from "./preview-bridge";

/** The renderer's `ThemeShell` (D53), plus the builder preview's bridge — which only Markii has. */
export function ThemeRoot({
  themeId,
  theme: resolved,
  preview = false,
  children,
}: {
  themeId?: string | null;
  /**
   * The site's published theme with its design-token overrides applied
   * (`loadSite` → `data.theme`, D51). Wins over `themeId` when given.
   */
  theme?: ThemeTokens;
  /** The builder's live preview (D51): adds the preview bridge. Never true for a shopper. */
  preview?: boolean;
  children: ReactNode;
}) {
  const theme = resolved ?? getTheme(themeId);
  return (
    <>
      <ThemeShell theme={theme}>{children}</ThemeShell>
      {preview ? <PreviewBridge /> : null}
    </>
  );
}
