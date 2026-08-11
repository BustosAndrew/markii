import { describe, expect, it } from "vitest";
import { THEMES, getTheme, resolveThemeId, themeStylesheet } from "./themes";

const ALL = Object.values(THEMES);

/**
 * Storefront themes.
 *
 * These exist because a theme is the closest thing in this codebase to a promise
 * made in the UI: a merchant picks one expecting their store to look different.
 * Two things have to stay true for that to be honest and safe — the themes must
 * actually differ, and differing must never change what an agent reads.
 */

describe("theme catalogue", () => {
  it("resolves an unknown id to a real theme rather than throwing", () => {
    expect(resolveThemeId("nonsense")).toBe("studio");
    expect(resolveThemeId(null)).toBe("studio");
    expect(getTheme(undefined).id).toBe("studio");
  });

  /**
   * The gap this closed: all four used to render an identical layout, so
   * switching theme changed only colours. A picker whose options are
   * interchangeable is a choice that is not really a choice.
   */
  it("gives every theme a distinct layout, not just a palette", () => {
    const shapes = ALL.map((t) => JSON.stringify(t.layout));
    expect(new Set(shapes).size, "two themes share a layout").toBe(ALL.length);
  });

  it("uses every layout option at least once", () => {
    // An option nothing selects is untested surface pretending to be a feature.
    expect(new Set(ALL.map((t) => t.layout.hero))).toEqual(
      new Set(["none", "banner", "editorial"]),
    );
    expect(new Set(ALL.map((t) => t.layout.productPage))).toEqual(
      new Set(["split", "stacked"]),
    );
    expect(new Set(ALL.map((t) => t.layout.productGrid))).toEqual(new Set(["grid", "list"]));
    expect(new Set(ALL.map((t) => t.layout.header))).toEqual(new Set(["split", "stacked"]));
  });

  it("describes itself in terms it can deliver", () => {
    for (const theme of ALL) {
      expect(theme.description.length).toBeGreaterThan(10);
      expect(theme.label).toBeTruthy();
      // Distinct typography is half of what makes them read as different stores.
      expect(theme.fontHref).toMatch(/^https:\/\/fonts\.googleapis\.com/);
    }
  });
});

describe("themeStylesheet", () => {
  it("emits layout rules that differ between themes", () => {
    const atlas = themeStylesheet(THEMES.atlas);
    const studio = themeStylesheet(THEMES.studio);
    expect(atlas).not.toBe(studio);

    // Atlas is the catalogue: list rows, no hero.
    expect(atlas).toContain("grid-template-columns:1fr");
    // Studio is editorial: a hero that is actually shown.
    expect(studio).not.toContain("clip-path:inset(50%)");
  });

  it("only ever stacks the product page on small screens", () => {
    /**
     * Split layouts are wrapped in a min-width query, so the base
     * `display:block` still governs a phone. Whatever a merchant picked, the
     * mobile experience is the stacked one — which is the right answer on a
     * narrow screen regardless.
     */
    for (const theme of ALL) {
      const css = themeStylesheet(theme);
      const splitIndex = css.indexOf(".sf-product{display:grid");
      if (splitIndex === -1) continue;
      expect(css.slice(0, splitIndex)).toContain("@media(min-width:820px)");
    }
  });

  /**
   * **The constraint that makes theming safe at all.** A theme rearranges the
   * same elements; it never removes one. `hero: "none"` therefore hides its
   * heading visually rather than deleting it, so every theme still emits the
   * same document for a screen reader or an agent — which is the product.
   */
  it("hides rather than deletes, so every theme emits the same document", () => {
    const atlas = themeStylesheet(THEMES.atlas);
    expect(THEMES.atlas.layout.hero).toBe("none");
    expect(atlas).toContain(".sf-hero{position:absolute");
    expect(atlas).toContain("clip-path:inset(50%)");
    // Never `display:none`, which would take it from assistive tech too.
    expect(atlas).not.toMatch(/\.sf-hero\{[^}]*display:none/);
  });

  it("stays valid CSS with balanced braces", () => {
    for (const theme of ALL) {
      const css = themeStylesheet(theme);
      const open = (css.match(/\{/g) ?? []).length;
      const close = (css.match(/\}/g) ?? []).length;
      expect(open, `${theme.id} has unbalanced braces`).toBe(close);
    }
  });
});
