import { describe, expect, it } from "vitest";
import { articleText, articleToMarkdown, autoExcerpt, parseArticle } from "./article";

/** Blog post Markdown — parsed to a tree, so these are about what the tree holds. */

describe("parseArticle", () => {
  it("never gives a body heading the title's h1", () => {
    expect(parseArticle("# One\n\n## Two\n\n### Three\n\n#### Four").map((b) => b.type)).toEqual(["h2", "h2", "h3", "h3"]);
  });

  it("takes https images on their own line and nothing else as an image", () => {
    const blocks = parseArticle("![Tea](https://cdn.test/tea.jpg)\n\n![Bad](http://cdn.test/x.jpg)\n\n![Worse](javascript:alert(1))");
    expect(blocks[0]).toEqual({ type: "img", src: "https://cdn.test/tea.jpg", alt: "Tea" });
    expect(blocks.slice(1).map((b) => b.type)).toEqual(["p", "p"]);
  });

  it("reads raw HTML as text", () => {
    const [p] = parseArticle('<script>alert(1)</script><img src=x onerror="y">');
    expect(p).toEqual({ type: "p", c: [{ t: "text", v: '<script>alert(1)</script><img src=x onerror="y">' }] });
  });

  it("parses quotes, lists, dividers and fenced code, keeping code verbatim", () => {
    const src = "> Brewed **slowly**\n\n- one\n- two\n\n---\n\n```js\nconst x = '<b>';\n\n# not a heading\n```\n\n1. first";
    expect(parseArticle(src).map((b) => b.type)).toEqual(["quote", "ul", "hr", "code", "ol"]);
    expect(parseArticle(src)[3]).toEqual({ type: "code", v: "const x = '<b>';\n\n# not a heading" });
  });

  it("drops unsafe links to their text", () => {
    const [p] = parseArticle("[click](javascript:alert(1)) and [ok](/p/tea)");
    expect(JSON.stringify(p)).not.toContain("javascript:");
    expect(articleToMarkdown("[ok](/p/tea)", "https://tea.markii.shop")).toBe("[ok](https://tea.markii.shop/p/tea)");
  });
});

describe("text and excerpts", () => {
  it("is the post's words, with images by their alt text", () => {
    expect(articleText("## Spring\n\nNew **leaves**.\n\n![A field](https://cdn.test/f.jpg)")).toBe("Spring New leaves. A field");
  });

  it("cuts an automatic excerpt on a word boundary", () => {
    const out = autoExcerpt("word ".repeat(100), 30);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
    expect(out.length).toBeLessThanOrEqual(31);
  });

  it("re-writes a post for agents with only what the page shows", () => {
    const md = articleToMarkdown("# Title\n\n<b>hi</b>\n\n![x](http://no)\n\n- a", "https://s.test");
    expect(md).toBe("## Title\n\n<b>hi</b>\n\n![x](http://no)\n\n- a");
  });
});
