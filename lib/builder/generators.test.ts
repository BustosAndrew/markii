import { describe, expect, it } from "vitest";
import type { Category, Product } from "@/lib/db";
import {
  generateAgentMd,
  generateLlmsFullTxt,
  generateLlmsTxt,
  generateSitemapXml,
  websiteJsonLd,
  type Bundle,
} from "@/lib/generators";
import { documentJsonLd, type RenderContext } from "@markii/renderer/render";
import { pageToMarkdown, type MarkdownContext } from "@markii/renderer/to-markdown";
import { emptyRoot, insertNodes, type IdGenerator, type NodeInput } from "@markii/renderer/tree";
import type { PageNode } from "@markii/renderer/types";

/**
 * M5 — the agent-facing documents read the published design. A page that
 * renders one thing to shoppers and describes another to agents is the failure
 * this guards: the Markdown and the structured data follow the same bindings,
 * visibility and catalogue as the HTML.
 */

function ids(): IdGenerator {
  let n = 0;
  return () => `n_${String(++n).padStart(10, "0")}`;
}

function page(nodes: NodeInput[]): PageNode {
  const id = ids();
  const root = emptyRoot(id);
  return insertNodes(root, nodes.map((node) => ({ parentId: root.id, node })), id).root;
}

const product = (over: Partial<Product>): Product =>
  ({
    id: 1, slug: "tea", name: "Green tea", enabled: true, priceCents: 1200, currency: "USD", stock: 4,
    categoryId: 7, suggestedProductIds: [], images: [], description: null, sku: null, ...over,
  }) as Product;

const products = [product({}), product({ id: 2, slug: "mug", name: "Mug", stock: 0, categoryId: null }), product({ id: 3, slug: "old", name: "Old", enabled: false })];
const categories = [{ id: 7, slug: "teas", name: "Teas" } as Category];
const store = { name: "Leaf & Co", url: "https://leaf.test/", copyright: "© 2026 Leaf & Co", hasCollections: false, productCount: 2 };

const mdCtx: MarkdownContext = {
  baseUrl: "https://leaf.test",
  products,
  categories,
  collections: [],
  values: { store },
  membersOf: async () => [],
  headingOffset: 2,
};

describe("a page as Markdown (llms-full.txt)", () => {
  it("writes the outline under the document's headings, with links made absolute and unsafe ones dropped", async () => {
    const md = await pageToMarkdown(
      page([
        {
          type: "section",
          children: [
            { type: "heading", props: { text: "Shipping\nand returns", level: 1 } },
            { type: "text", props: { markdown: "Read the [policy](/pages/policy) or [this](javascript:void).\n\n- One\n- Two" } },
            { type: "faq", props: { items: [{ question: "How long?", answer: "**Three** days." }] } },
            { type: "button", props: { label: "Shop", href: "/collections" } },
            { type: "image", props: { src: "https://cdn.test/a.jpg", alt: "A pot" } },
            { type: "image", props: { src: "https://cdn.test/b.jpg", decorative: true } },
          ],
        },
      ]),
      mdCtx,
    );
    expect(md).toContain("### Shipping and returns");
    expect(md).toContain("[policy](https://leaf.test/pages/policy)");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("Read the [policy](https://leaf.test/pages/policy) or this.");
    expect(md).toContain("- One\n- Two");
    expect(md).toContain("**Q: How long?**\n\n**Three** days.");
    expect(md).toContain("[Shop](https://leaf.test/collections)");
    expect(md).toContain("![A pot](https://cdn.test/a.jpg)");
    // A decorative image says nothing to an agent.
    expect(md).not.toContain("b.jpg");
  });

  it("lists products as links with price and stock, enabled only, whatever cards drew them", async () => {
    const md = await pageToMarkdown(
      page([
        { type: "section", children: [{ type: "productGrid", props: { source: "all" } }] },
        {
          type: "section",
          children: [{ type: "repeater", props: { source: "store.products" }, children: [{ type: "heading", props: { text: "x", level: 3 }, bindings: { text: "item.title" } }] }],
        },
      ]),
      mdCtx,
    );
    expect(md).toContain("- [Green tea](https://leaf.test/p/tea) — $12.00");
    expect(md).toContain("- [Mug](https://leaf.test/p/mug) — $12.00 (out of stock)");
    expect(md).not.toContain("Old");
    // The repeater's per-item design is not repeated as headings.
    expect(md).not.toContain("### x");
  });

  it("applies bindings and hides what shoppers do not see", async () => {
    const md = await pageToMarkdown(
      page([
        {
          type: "section",
          children: [
            { type: "heading", props: { text: "Placeholder", level: 1 }, bindings: { text: "store.name" } },
            { type: "text", props: { markdown: "Shown" }, visibleWhen: { path: "store.productCount", op: "gt", value: 0 } },
            { type: "text", props: { markdown: "Hidden" }, visibleWhen: { path: "store.hasCollections", op: "eq", value: true } },
            // Unanswerable on a page: hidden, as it is live.
            { type: "text", props: { markdown: "Template only" }, visibleWhen: { path: "product.inStock", op: "eq", value: true } },
            { type: "productBuy" },
          ],
        },
      ]),
      mdCtx,
    );
    expect(md).toContain("### Leaf & Co");
    expect(md).not.toContain("Placeholder");
    expect(md).toContain("Shown");
    expect(md).not.toContain("Hidden");
    expect(md).not.toContain("Template only");
  });
});

const bundle: Bundle = {
  site: { name: "Leaf & Co", slug: "leaf" },
  categories: [],
  products: [{ name: "Green tea", slug: "tea", priceCents: 1200, currency: "USD", stock: 4, images: [] }],
};

describe("the discovery documents list the store's pages", () => {
  const pages = [{ title: "Shipping", path: "/pages/shipping", description: "<p>Where we ship</p>" }];

  it("llms.txt links each page and the full-text document — and is unchanged without pages", () => {
    const with_ = generateLlmsTxt(bundle, "https://leaf.test", { pages });
    expect(with_).toContain("- Full text of the store's pages: https://leaf.test/llms-full.txt");
    expect(with_).toContain("## Pages\n\n- [Shipping](https://leaf.test/pages/shipping): Where we ship");
    const without = generateLlmsTxt(bundle, "https://leaf.test");
    expect(without).not.toContain("llms-full.txt");
    expect(without).not.toContain("## Pages");
  });

  it("agent.md points at the full text, naming the pages", () => {
    expect(generateAgentMd(bundle, "https://leaf.test", { pages })).toContain("`GET https://leaf.test/llms-full.txt` — the store's own pages (Shipping)");
    expect(generateAgentMd(bundle, "https://leaf.test")).not.toContain("llms-full.txt");
  });

  it("the sitemap gains each page once, and the home page stays one entry", () => {
    const xml = generateSitemapXml(bundle, "https://leaf.test", ["/", "/pages/shipping"]);
    expect(xml).toContain("<loc>https://leaf.test/pages/shipping</loc>");
    expect(xml.match(/<loc>https:\/\/leaf\.test\/<\/loc>/g)).toHaveLength(1);
  });

  it("llms-full.txt is each page's text under its title and address", () => {
    const txt = generateLlmsFullTxt(bundle, "https://leaf.test", [{ ...pages[0], markdown: "### Shipping\n\nWe ship worldwide." }]);
    expect(txt.startsWith("# Leaf & Co — pages\n")).toBe(true);
    expect(txt).toContain("## Shipping\n\nURL: https://leaf.test/pages/shipping\nSummary: Where we ship\n\n### Shipping\n\nWe ship worldwide.");
  });

  it("the home page's WebSite JSON-LD carries a search action", () => {
    expect(websiteJsonLd("Leaf", "https://leaf.test").potentialAction.target).toBe("https://leaf.test/search?q={search_term_string}");
  });
});

describe("a builder page's structured data", () => {
  const ctx: RenderContext = {
    baseUrl: "https://leaf.test",
    products,
    categories,
    collections: [],
    membersOf: async () => [],
    values: { store },
    page: { name: "Teas", description: "All our teas", url: "https://leaf.test/pages/teas" },
  };

  it("is a WebPage, an FAQPage and an ItemList per visible listing", async () => {
    const ld = (await documentJsonLd(
      page([
        {
          type: "section",
          children: [
            { type: "faq", props: { items: [{ question: "Q?", answer: "*A*" }] } },
            { type: "productGrid", props: { source: "category", categorySlug: "teas" } },
            { type: "productGrid", props: { source: "all" }, visibleWhen: { path: "store.hasCollections", op: "eq", value: true } },
            { type: "repeater", props: { source: "collection.products" }, children: [{ type: "text", props: { markdown: "x" } }] },
          ],
        },
      ]),
      ctx,
    )) as Record<string, any>[];
    expect(ld.map((x) => x["@type"])).toEqual(["WebPage", "FAQPage", "ItemList"]);
    expect(ld[0]).toMatchObject({ name: "Teas", url: "https://leaf.test/pages/teas", isPartOf: { name: "Leaf & Co" } });
    expect(ld[1].mainEntity[0].acceptedAnswer.text).toBe("A");
    expect(ld[2]).toMatchObject({ name: "Teas", numberOfItems: 1, itemListElement: [{ position: 1, url: "https://leaf.test/p/tea", name: "Green tea" }] });
  });

  it("says nothing of a template's own page — its route does", async () => {
    const ld = await documentJsonLd(page([{ type: "section", children: [{ type: "text", props: { markdown: "x" } }] }]), { ...ctx, page: undefined });
    expect(ld).toEqual([]);
  });
});
