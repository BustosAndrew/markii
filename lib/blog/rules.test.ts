import { createElement } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { ArticleBody, articleStructuredData } from "@markii/renderer/article-view";
import { descriptionOf, excerptOf, freeHandle, handleFromTitle, postStatus, publishProblems } from "./rules";

describe("post status", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  it("is derived from the date alone — a schedule needs nothing to run", () => {
    expect(postStatus(null, now)).toBe("draft");
    expect(postStatus(new Date("2026-11-23T00:00:00Z"), now)).toBe("scheduled");
    expect(postStatus(new Date("2026-11-22T12:00:00Z"), now)).toBe("published");
    expect(postStatus(new Date("2026-01-01T00:00:00Z"), now)).toBe("published");
  });
});

describe("handles", () => {
  it("come from the title and never collide", () => {
    expect(handleFromTitle("Spring Harvest: Darjeeling's First Flush!")).toBe("spring-harvest-darjeeling-s-first-flush");
    expect(handleFromTitle("Thé vert")).toBe("the-vert");
    expect(handleFromTitle("!!!")).toBe("post");
    expect(freeHandle("tea", new Set(["tea", "tea-2"]))).toBe("tea-3");
    expect(freeHandle("tea", new Set())).toBe("tea");
  });
});

describe("publishing", () => {
  it("refuses a post with no words and warns about a cover with no alt text", () => {
    expect(publishProblems({ title: "x", body: "  ", coverImage: null, coverAlt: "" }).errors.map((e) => e.code)).toEqual(["EMPTY_POST"]);
    const ok = publishProblems({ title: "x", body: "Hello", coverImage: "https://cdn.test/c.jpg", coverAlt: "" });
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.map((w) => w.code)).toEqual(["MISSING_ALT"]);
  });

  it("describes a post by SEO first, then its excerpt, then its opening words", () => {
    expect(descriptionOf({ excerpt: "", body: "Opening words.", seo: {} })).toBe("Opening words.");
    expect(excerptOf({ excerpt: "Mine", body: "Opening words." })).toBe("Mine");
    expect(descriptionOf({ excerpt: "Mine", body: "x", seo: { description: "SEO" } })).toBe("SEO");
  });
});

describe("rendering", () => {
  async function html(src: string, hasCover = false) {
    const { prelude } = await prerender(createElement(ArticleBody, { src, baseUrl: "https://tea.markii.shop", hasCover }));
    return new Response(prelude).text();
  }

  it("draws markup only from the tree — a pasted script is text", async () => {
    const out = await html("<script>alert(1)</script>\n\n## Heading\n\n[home](/)");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("<h2>Heading</h2>");
    expect(out).toContain('href="https://tea.markii.shop/"');
  });

  it("loads the first image at once unless a cover leads the page", async () => {
    const src = "![a](https://cdn.test/a.jpg)\n\n![b](https://cdn.test/b.jpg)";
    const tags = [...(await html(src)).matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(tags[0]).toContain('loading="eager"');
    expect(tags[1]).toContain('loading="lazy"');
    expect([...(await html(src, true)).matchAll(/loading="eager"/g)]).toHaveLength(0);
  });

  it("names the store as author when the byline is empty", () => {
    const ld = articleStructuredData({
      title: "T",
      description: "D",
      url: "https://s.test/blog/t",
      publishedAt: "2026-11-01T00:00:00.000Z",
      modifiedAt: "2026-11-02T00:00:00.000Z",
      store: { name: "Tea", url: "https://s.test/" },
    }) as { author: { "@type": string; name: string } };
    expect(ld.author).toEqual({ "@type": "Organization", name: "Tea", url: "https://s.test/" });
  });
});
