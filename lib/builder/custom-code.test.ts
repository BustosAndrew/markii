import { describe, expect, it } from "vitest";
import { customCssClasses } from "@/lib/ops-agents/brand/format";
import { cssProblems, sanitizeHtml } from "@markii/renderer/sanitize";
import { TreeError, customHtmlOf, emptyRoot, insertNodes, locate, setCustomClass, type IdGenerator } from "@markii/renderer/tree";

/**
 * M6 — custom code (`docs/BUILDER.md` §8). The sanitiser is the boundary
 * between what a merchant pastes and what a shopper's browser runs, so these
 * are written as attacks: each input is a known way to get script onto a page,
 * and each must come out inert.
 */

function ids(): IdGenerator {
  let n = 0;
  return () => `n_${String(++n).padStart(10, "0")}`;
}

describe("custom HTML is rebuilt from an allowlist", () => {
  const cases: [string, string][] = [
    ["<script>alert(1)</script><p>ok</p>", "<p>ok</p>"],
    ['<img src="https://x.test/a.png" onerror="alert(1)">', '<img src="https://x.test/a.png">'],
    ['<img src="x" onerror="alert(1)">', ""],
    ['<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="  javascript:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', "<a>x</a>"],
    ['<a href="//evil.test">x</a>', "<a>x</a>"],
    ['<iframe src="https://evil.test"></iframe><p>after</p>', "<p>after</p>"],
    ["<style>body{display:none}</style>visible", "visible"],
    ['<svg><script>alert(1)</script></svg>', ""],
    ['<svg onload="alert(1)"></svg>', ""],
    ['<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', ""],
    ['<form action="https://evil.test"><input name="card"></form>', ""],
    ['<div style="background:url(javascript:alert(1))">x</div>', "<div>x</div>"],
    ['<p onclick="alert(1)" onmouseover="x">hi</p>', "<p>hi</p>"],
    ['<object data="evil.swf"></object>', ""],
    ['<base href="https://evil.test/">', ""],
    ['<meta http-equiv="refresh" content="0;url=https://evil.test">', ""],
    // The mutation-XSS classic: the parser ends the noscript early, the image goes, and only inert text is left.
    ['<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', '"&gt;'],
    ["<!-- <script>alert(1)</script> -->plain", "plain"],
    ["<p>1 &lt; 2 &amp; <b>bold</b></p>", "<p>1 &lt; 2 &amp; <b>bold</b></p>"],
    ['<div data-mk-node="n_aaaaaaaaaa" data-promo="x">x</div>', '<div data-promo="x">x</div>'],
    ['<div class="hero mk-b-section sf-btn">x</div>', '<div class="hero">x</div>'],
    ["<center><font color=red>legacy</font></center>", "legacy"],
  ];
  for (const [input, expected] of cases) {
    it(JSON.stringify(input).slice(0, 70), () => {
      expect(sanitizeHtml(input)).toBe(expected);
    });
  }

  it("keeps ordinary content, escapes text, and makes new tabs safe", () => {
    const out = sanitizeHtml(
      '<section id="promo" aria-label="Promo"><h2>Sale</h2><p>Up to <strong>30%</strong> off &amp; free "shipping".</p>' +
        '<a href="/collections/sale" target="_blank">Shop</a><img src="https://cdn.test/a.jpg" alt="" width="400"></section>',
    );
    expect(out).toBe(
      '<section id="promo" aria-label="Promo"><h2>Sale</h2><p>Up to <strong>30%</strong> off &amp; free "shipping".</p>' +
        '<a href="/collections/sale" target="_blank" rel="noopener noreferrer">Shop</a><img src="https://cdn.test/a.jpg" alt="" width="400"></section>',
    );
  });

  it("is idempotent — cleaning clean HTML changes nothing", () => {
    const once = sanitizeHtml('<p onclick="x">a <a href="https://x.test" target="_blank">b</a></p><script>y</script>');
    expect(sanitizeHtml(once)).toBe(once);
  });

  it("never lets an attribute value break out of its quotes", () => {
    const out = sanitizeHtml('<p title="a&quot; onmouseover=&quot;alert(1)">x</p>');
    expect(out).toBe('<p title="a&quot; onmouseover=&quot;alert(1)">x</p>');
  });
});

describe("theme CSS is checked", () => {
  it("accepts ordinary rules", () => {
    expect(cssProblems(".promo { color: #c9184a; background: url(https://cdn.test/bg.png) } @media (min-width: 640px) { .promo { padding: 2rem } }")).toEqual([]);
  });

  it("refuses what could leave the style element, fetch, or run", () => {
    expect(cssProblems("</style><script>alert(1)</script>").length).toBeGreaterThan(0);
    expect(cssProblems('@import url("https://evil.test/x.css");')).toContain("@import is not allowed; put the rules here instead.");
    expect(cssProblems("a { background: url(http://evil.test/x) }")).toContain("url(http://evil.test/x) must be an https:// address.");
    expect(cssProblems("a { background: url(data:image/svg+xml;base64,AAA) }").length).toBe(1);
    expect(cssProblems("a { width: expression(alert(1)) }")).toContain("Script in CSS is not allowed.");
    expect(cssProblems("a { color: red")).toContain("Custom CSS has unbalanced braces.");
    expect(cssProblems("x".repeat(20_001)).length).toBe(1);
  });

  it("is not fooled by a comment hiding the keyword from a naive check", () => {
    expect(cssProblems("/* harmless */ @import 'https://evil.test/x.css';").length).toBeGreaterThan(0);
    expect(cssProblems("/* @import */ .ok { color: red }")).toEqual([]);
  });

  it("names the classes it defines for the brand agent, never the builder's", () => {
    expect(customCssClasses(".promo, .promo-banner:hover { margin: .5em } .mk-b-text { x: y } @media (min-width:1px) { .wide { } }")).toEqual([
      "promo",
      "promo-banner",
      "wide",
    ]);
  });
});

describe("custom code in the tree", () => {
  const tree = () => {
    const id = ids();
    const root = emptyRoot(id);
    return insertNodes(root, [{ parentId: root.id, node: { type: "section", children: [{ type: "html", props: { html: '<p onclick="x">Hi</p><script>bad()</script>' } }] } }], id).root;
  };

  it("stores custom HTML cleaned, whatever wrote it", () => {
    const html = tree().children![0].children![0].props.html;
    expect(html).toBe("<p>Hi</p>");
  });

  it("finds the custom HTML in a tree, for the author check", () => {
    expect([...customHtmlOf(tree()).values()]).toEqual(["<p>Hi</p>"]);
  });

  it("takes valid custom classes and refuses reserved or malformed ones", () => {
    const t = tree();
    const id = t.children![0].id;
    const set = setCustomClass(t, id, "promo  hero promo");
    expect(set.after).toBe("promo hero");
    expect(locate(set.root, id)!.node.customClass).toBe("promo hero");
    expect(() => setCustomClass(t, id, "mk-b-section")).toThrow(/belong to the builder/);
    expect(() => setCustomClass(t, id, "sf-btn")).toThrow(TreeError);
    expect(() => setCustomClass(t, id, 'x" onclick="y')).toThrow(/not a usable class name/);
    expect(() => setCustomClass(t, id, "a b c d e f")).toThrow(/At most 5/);
    expect(setCustomClass(set.root, id, null).after).toBeNull();
  });
});
