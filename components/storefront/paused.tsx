import { ThemeRoot } from "./theme-root";

export function StorePaused({
  siteName,
  themeId,
}: {
  siteName: string;
  themeId?: string | null;
}) {
  return (
    <ThemeRoot themeId={themeId}>
      <main className="sf-main" style={{ textAlign: "center", paddingTop: "4rem" }}>
        <h1 className="sf-title">{siteName}</h1>
        <p className="sf-lede">
          This store is temporarily paused. Please check back later.
        </p>
      </main>
    </ThemeRoot>
  );
}
