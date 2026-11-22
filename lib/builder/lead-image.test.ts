import { createElement } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { BuilderPage, leadImageId, type RenderContext } from "@markii/renderer/render";
import type { PageNode } from "@markii/renderer/types";

/**
 * `docs/BUILDER.md` §13 — the page's lead image is fetched at once. A hero
 * that is `loading="lazy"` waits for layout before the browser asks for it,
 * which makes the largest thing above the fold the last thing to arrive.
 */

const img = (id: string): PageNode => ({ id: `n_${id.padStart(10, "0")}`, type: "image", props: { src: `https://cdn.test/${id}.jpg`, alt: id } });
const section = (id: string, children: PageNode[]): PageNode => ({ id: `n_${id.padStart(10, "0")}`, type: "section", props: {}, children });
const page = (children: PageNode[]): PageNode => ({ id: "n_000000root", type: "root", props: {}, children });

const ctx: RenderContext = {
  baseUrl: "https://tea.markii.shop",
  products: [],
  categories: [],
  collections: [],
  membersOf: async () => [],
  values: { store: { name: "Tea", url: "https://tea.markii.shop", copyright: "Tea", hasCollections: false, productCount: 0 } },
};

async function html(tree: PageNode): Promise<string> {
  const { prelude } = await prerender(createElement(BuilderPage, { tree, ctx }));
  return new Response(prelude).text();
}

describe("lead image", () => {
  it("is the first image inside the first top-level block", () => {
    expect(leadImageId(page([section("a", [section("b", [img("hero"), img("two")])]), section("c", [img("low")])]))).toBe("n_000000hero");
  });

  it("is nothing when the first block has no image — an image further down is not promoted", () => {
    expect(leadImageId(page([section("a", []), section("c", [img("low")])]))).toBeUndefined();
    expect(leadImageId(page([]))).toBeUndefined();
  });

  it("renders eager at high priority, and every other image lazy", async () => {
    const out = await html(page([section("a", [img("hero"), img("two")]), section("c", [img("low")])]));
    const tags = [...out.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(tags).toHaveLength(3);
    expect(tags[0]).toContain('src="https://cdn.test/hero.jpg"');
    expect(tags[0]).toContain('loading="eager"');
    expect(tags[0]).toContain('fetchPriority="high"');
    for (const tag of tags.slice(1)) {
      expect(tag).toContain('loading="lazy"');
      expect(tag).not.toContain("fetchPriority");
    }
  });
});
