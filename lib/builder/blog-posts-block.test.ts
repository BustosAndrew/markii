import { createElement } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";
import { BLOCKS } from "@markii/renderer/blocks";
import type { RenderPost } from "@markii/renderer/catalog";
import { BuilderPage, type RenderContext } from "@markii/renderer/render";
import { pageToMarkdown, type MarkdownContext } from "@markii/renderer/to-markdown";
import type { PageNode } from "@markii/renderer/types";

/**
 * The `blogPosts` block — the store's newest live posts on any page. It reads
 * them through `ctx.postsOf`, which Markii answers from its database and an
 * export from `GET /api/blog/posts`; the drawing is `PostList`, the same one
 * `/blog` uses.
 */

const post = (n: number, extra: Partial<RenderPost> = {}): RenderPost => ({
  handle: `post-${n}`,
  title: `Post ${n}`,
  excerpt: `About ${n}`,
  coverImage: `https://cdn.test/${n}.jpg`,
  coverAlt: `Cover ${n}`,
  author: "Ana",
  publishedAt: "2026-11-01T12:00:00.000Z",
  ...extra,
});

const node = (props: Record<string, unknown> = {}): PageNode => ({ id: "n_00000posts", type: "blogPosts", props: { limit: 3, layout: "grid", showExcerpts: true, showImages: true, ...props } });
const page = (child: PageNode): PageNode => ({ id: "n_000000root", type: "root", props: {}, children: [child] });

const store = { name: "Tea", url: "https://tea.markii.shop", copyright: "Tea", hasCollections: false, productCount: 0 };
const base = { baseUrl: "https://tea.markii.shop", products: [], categories: [], collections: [], membersOf: async () => [], values: { store } };

async function html(tree: PageNode, ctx: Partial<RenderContext> = {}): Promise<string> {
  const { prelude } = await prerender(createElement(BuilderPage, { tree, ctx: { ...base, ...ctx } }));
  return new Response(prelude).text();
}

describe("blogPosts block", () => {
  it("defaults validate, and the limit is held to twelve", () => {
    const def = BLOCKS.get("blogPosts")!;
    expect(def.schema.safeParse(def.defaults.props).success).toBe(true);
    expect(def.schema.safeParse({ ...def.defaults.props, limit: 13 }).success).toBe(false);
    expect(def.insertable).toBe(true);
  });

  it("asks for as many posts as it shows and links each to its page", async () => {
    const postsOf = vi.fn(async (limit: number) => [post(1), post(2)].slice(0, limit));
    const out = await html(page(node({ limit: 2 })), { postsOf });
    expect(postsOf).toHaveBeenCalledWith(2);
    expect(out).toContain('href="https://tea.markii.shop/blog/post-1"');
    expect(out).toContain('href="https://tea.markii.shop/blog/post-2"');
    expect(out).toContain('<time dateTime="2026-11-01T12:00:00.000Z">November 1, 2026</time>');
    // Under a section's own heading, so the cards are h3 — never a second h1 or a sibling h2.
    expect(out).toContain("<h3>Post 1</h3>");
    expect(out).not.toMatch(/<h[12]>/);
    expect(out).toContain('src="https://cdn.test/1.jpg"');
    expect(out).toContain("About 1");
  });

  it("draws side by side unless asked for a list, and can leave out images and excerpts", async () => {
    const postsOf = async () => [post(1)];
    expect(await html(page(node()), { postsOf })).toMatch(/<ol class="[^"]*mk-posts-grid/);
    const list = await html(page(node({ layout: "list", showImages: false, showExcerpts: false })), { postsOf });
    expect(list).not.toContain("mk-posts-grid");
    expect(list).not.toContain("<img");
    expect(list).not.toContain("About 1");
  });

  it("draws nothing for shoppers when there are no posts, or no way to read them", async () => {
    expect(await html(page(node()), { postsOf: async () => [] })).not.toContain("sf-posts");
    expect(await html(page(node()))).not.toContain("sf-posts");
    // The preview keeps a placeholder so the merchant can still select the block.
    expect(await html(page(node()), { preview: true })).toContain('data-mk-empty="latest posts — none published yet"');
  });

  it("escapes what a merchant typed", async () => {
    const out = await html(page(node()), { postsOf: async () => [post(1, { title: "<script>x</script>" })] });
    expect(out).not.toContain("<script>x");
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("is a list of links in llms-full.txt, and absent there without postsOf", async () => {
    const ctx: MarkdownContext = { ...base, postsOf: async () => [post(1), post(2, { excerpt: "" })] };
    expect(await pageToMarkdown(page(node()), ctx)).toBe(
      "- [Post 1](https://tea.markii.shop/blog/post-1): About 1\n- [Post 2](https://tea.markii.shop/blog/post-2)",
    );
    expect(await pageToMarkdown(page(node({ showExcerpts: false })), ctx)).toBe(
      "- [Post 1](https://tea.markii.shop/blog/post-1)\n- [Post 2](https://tea.markii.shop/blog/post-2)",
    );
    expect(await pageToMarkdown(page(node()), base)).toBe("");
  });
});
