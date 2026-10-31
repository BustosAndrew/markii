import { describe, expect, it } from "vitest";
import { BLOCKS, canContain, describeBlocks, getBlock } from "./blocks";
import { checkPage, type CatalogFacts } from "./checks";
import { markdownText, parseInline, parseMarkdown, safeHref } from "./markdown";
import { PRESETS, blankPageTree, defaultHomeTree } from "./presets";
import { RENDERED_TYPES, pageJsonLd, resolveHref } from "./render";
import { compileStyles, declarations } from "./styles";
import { applyTokenPatch, contrastRatio, contrastWarnings, mergedFontHref, resolveTheme } from "./tokens";
import {
  TreeError,
  buildNode,
  duplicateNode,
  emptyRoot,
  insertNodes,
  locate,
  moveNode,
  removeNodes,
  setProps,
  setStyles,
  validateTree,
  type IdGenerator,
} from "./tree";
import { TREE_LIMITS, type PageNode } from "./types";
import { getTheme } from "@/lib/storefront/themes";

/**
 * The builder's pure core (D51). Every builder action is a thin wrapper over
 * these, so a bug here is a bug in what a merchant — or the brand agent —
 * writes into a draft that ships to shoppers on publish.
 */

/** Deterministic ids: n_0000000001, n_0000000002, … */
function ids(): IdGenerator {
  let n = 0;
  return () => `n_${String(++n).padStart(10, "0")}`;
}

function page(): PageNode {
  const id = ids();
  const root = emptyRoot(id);
  return insertNodes(
    root,
    [
      { parentId: root.id, node: { type: "section", children: [{ type: "heading", props: { text: "Hi", level: 1 } }] } },
      { parentId: root.id, node: { type: "section", children: [{ type: "text", props: { markdown: "Body" } }] } },
    ],
    id,
  ).root;
}

const noCatalog: CatalogFacts = { productSlugs: new Set(), categorySlugs: new Set(), collectionHandles: new Set() };

describe("tree operations", () => {
  it("inserts with defaults applied and ids assigned", () => {
    const root = page();
    expect(root.children).toHaveLength(2);
    const section = root.children![0];
    expect(section.type).toBe("section");
    // A new section gets the block's default styles.
    expect(section.styles?.base?.paddingY).toBe("xl");
    expect(section.children![0].props).toEqual({ text: "Hi", level: 1 });
  });

  it("refuses nesting the registry forbids, unknown types and bad props", () => {
    const root = page();
    const section = root.children![0];
    expect(() => insertNodes(root, [{ parentId: section.id, node: { type: "section" } }])).toThrow(TreeError);
    expect(() => insertNodes(root, [{ parentId: root.id, node: { type: "column" } }])).toThrow(/cannot go inside/);
    expect(() => insertNodes(root, [{ parentId: root.id, node: { type: "marquee" } }])).toThrow(/Unknown block type/);
    expect(() =>
      insertNodes(root, [{ parentId: section.id, node: { type: "heading", props: { text: "", level: 2 } } }]),
    ).toThrow(TreeError);
    expect(() =>
      insertNodes(root, [{ parentId: section.id, node: { type: "button", props: { label: "Go", href: "javascript:alert(1)" } } }]),
    ).toThrow(TreeError);
  });

  it("never mutates its input", () => {
    const root = page();
    const before = JSON.stringify(root);
    insertNodes(root, [{ parentId: root.id, node: { type: "section" } }]);
    removeNodes(root, [root.children![0].id]);
    setProps(root, root.children![0].children![0].id, { text: "Changed" });
    expect(JSON.stringify(root)).toBe(before);
  });

  it("removes outermost nodes and records how to put them back", () => {
    const root = page();
    const section = root.children![1];
    const inner = section.children![0];
    const { root: after, removed } = removeNodes(root, [inner.id, section.id]);
    // The text went with its section, so only the section is recorded.
    expect(removed.map((r) => r.node.id)).toEqual([section.id]);
    expect(after.children).toHaveLength(1);

    // Re-inserting what was removed, ids and all, restores the tree exactly.
    const restored = insertNodes(after, removed.map((r) => ({ parentId: r.parentId, index: r.index, node: r.node }))).root;
    expect(restored).toEqual(root);
  });

  it("restores several removed siblings to their original positions", () => {
    const id = ids();
    const root = emptyRoot(id);
    const built = insertNodes(
      root,
      ["a", "b", "c", "d"].map((t) => ({ parentId: root.id, node: { type: "section", props: { label: t } } })),
      id,
    ).root;
    const [a, , c] = built.children!;
    const { root: after, removed } = removeNodes(built, [c.id, a.id]);
    const restored = insertNodes(after, removed.map((r) => ({ parentId: r.parentId, index: r.index, node: r.node }))).root;
    expect(restored.children!.map((n) => n.props.label)).toEqual(["a", "b", "c", "d"]);
  });

  it("moves a node and reports where it came from, and refuses moving it into itself", () => {
    const root = page();
    const [first, second] = root.children!;
    const { root: moved, from, to } = moveNode(root, second.id, root.id, 0);
    expect(moved.children!.map((n) => n.id)).toEqual([second.id, first.id]);
    expect(from).toEqual({ parentId: root.id, index: 1 });
    expect(to).toEqual({ parentId: root.id, index: 0 });
    expect(() => moveNode(root, first.id, first.children![0].id)).toThrow(/inside itself/);
  });

  it("duplicates a subtree with fresh ids, right after the original", () => {
    const root = page();
    const first = root.children![0];
    const { root: after, newId } = duplicateNode(root, first.id);
    expect(after.children!.map((n) => n.id)).toEqual([first.id, newId, root.children![1].id]);
    const copy = locate(after, newId)!.node;
    expect(copy.children![0].id).not.toBe(first.children![0].id);
    expect(copy.children![0].props).toEqual(first.children![0].props);
  });

  it("reports only the props that changed, and validates the merge", () => {
    const root = page();
    const heading = root.children![0].children![0];
    const { changes } = setProps(root, heading.id, { text: "Hi", level: 2 });
    expect(changes).toEqual([{ key: "level", before: 1, after: 2 }]);
    expect(() => setProps(root, heading.id, { level: 9 })).toThrow(TreeError);
    expect(() => setProps(root, "n_9999999999", { text: "x" })).toThrow(/No node/);
  });

  it("sets and clears style tokens per breakpoint, refusing raw CSS", () => {
    const root = page();
    const section = root.children![0];
    const { root: styled, changes } = setStyles(root, section.id, "md", { paddingY: "3xl" });
    expect(changes).toEqual([{ key: "paddingY", before: null, after: "3xl" }]);
    expect(locate(styled, section.id)!.node.styles?.md).toEqual({ paddingY: "3xl" });
    const cleared = setStyles(styled, section.id, "md", { paddingY: null }).root;
    expect(locate(cleared, section.id)!.node.styles?.md).toBeUndefined();
    expect(() => setStyles(root, section.id, "base", { paddingY: "17px" })).toThrow(TreeError);
    expect(() => setStyles(root, section.id, "base", { position: "absolute" })).toThrow(TreeError);
  });

  it("enforces the node and depth limits", () => {
    const id = ids();
    const root = emptyRoot(id);
    const many = Array.from({ length: TREE_LIMITS.maxNodes }, () => ({ parentId: root.id, node: { type: "spacer" } }));
    expect(() => insertNodes(root, many, id)).toThrow(/at most 500/);

    const deep: PageNode = { id: id(), type: "root", props: {}, children: [] };
    let cursor = { id: id(), type: "section", props: {}, children: [] as PageNode[] };
    deep.children = [cursor];
    for (let i = 0; i < TREE_LIMITS.maxDepth + 1; i++) {
      const next = { id: id(), type: "grid", props: { minItemWidth: "md" }, children: [] as PageNode[] };
      cursor.children = [next];
      cursor = next;
    }
    expect(() => validateTree(deep)).toThrow(/deep/);
  });

  it("keeps a supplied id unless it is already taken", () => {
    const taken = new Set(["n_aaaaaaaaaa"]);
    const kept = buildNode({ id: "n_bbbbbbbbbb", type: "divider" }, taken, ids());
    expect(kept.id).toBe("n_bbbbbbbbbb");
    const fresh = buildNode({ id: "n_aaaaaaaaaa", type: "divider" }, taken, ids());
    expect(fresh.id).not.toBe("n_aaaaaaaaaa");
  });
});

describe("markdown", () => {
  it("parses paragraphs, lists and inline marks", () => {
    expect(parseMarkdown("One **bold** and *it*.\n\n- a\n- b\n\n1. x\n2. y")).toEqual([
      { type: "p", c: [{ t: "text", v: "One " }, { t: "strong", c: [{ t: "text", v: "bold" }] }, { t: "text", v: " and " }, { t: "em", c: [{ t: "text", v: "it" }] }, { t: "text", v: "." }] },
      { type: "ul", items: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] },
      { type: "ol", items: [[{ t: "text", v: "x" }], [{ t: "text", v: "y" }]] },
    ]);
  });

  it("treats HTML as text, so nothing can be injected", () => {
    const parsed = parseMarkdown("<script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(parsed).toEqual([{ type: "p", c: [{ t: "text", v: "<script>alert(1)</script> <img src=x onerror=alert(1)>" }] }]);
  });

  it("drops unsafe link targets, keeping their text", () => {
    // No link node, whatever is left over: the safety property is that nothing becomes an href.
    for (const evil of ["[x](javascript:alert(1))", "[x](//evil.test)", "[x](data:text/html,hi)"]) {
      expect(parseInline(evil).some((n) => n.t === "link"), evil).toBe(false);
    }
    expect(parseInline("[shop](/collections)")).toEqual([{ t: "link", href: "/collections", c: [{ t: "text", v: "shop" }] }]);
    for (const ok of ["https://a.test/x", "mailto:a@b.test", "/p/mug", "#faq"]) expect(safeHref(ok), ok).toBe(ok);
    for (const bad of ["javascript:void(0)", "data:text/html,x", "//x.test", "ftp://x"]) expect(safeHref(bad), bad).toBeNull();
  });

  it("flattens to plain words", () => {
    expect(markdownText("Free **shipping** over [$50](/pages/shipping).\n\n- fast")).toBe("Free shipping over $50. fast");
  });
});

describe("styles", () => {
  it("compiles tokens to per-node classes, mobile first", () => {
    const tree: PageNode = {
      id: "n_aaaaaaaaaa",
      type: "root",
      props: {},
      children: [{ id: "n_bbbbbbbbbb", type: "section", props: {}, styles: { base: { paddingY: "md" }, lg: { paddingY: "3xl" } } }],
    };
    expect(compileStyles(tree)).toBe(
      ".mk-n_bbbbbbbbbb{padding-top:1rem;padding-bottom:1rem}@media (min-width:1024px){.mk-n_bbbbbbbbbb{padding-top:6rem;padding-bottom:6rem}}",
    );
  });

  it("pairs a background with a readable text colour unless one is set", () => {
    expect(declarations({ background: "accent" })).toEqual(["background:var(--sf-accent)", "color:var(--sf-accent-text)"]);
    expect(declarations({ background: "accent", color: "fg" })).toEqual(["background:var(--sf-accent)", "color:var(--sf-fg)"]);
  });
});

describe("design tokens", () => {
  it("overrides a theme token by token, and resets with null", () => {
    const tokens = applyTokenPatch({}, { accent: "#c9184a", fontDisplay: "Fraunces" });
    expect(tokens).toEqual({ accent: "#C9184A", fontDisplay: "Fraunces" });
    const theme = resolveTheme("studio", tokens);
    expect(theme.accent).toBe("#C9184A");
    expect(theme.fontDisplay).toContain("Fraunces");
    expect(theme.background).toBe(getTheme("studio").background);
    expect(applyTokenPatch(tokens, { accent: null })).toEqual({ fontDisplay: "Fraunces" });
  });

  it("refuses colours that are not hex and fonts that are not on the list", () => {
    expect(() => applyTokenPatch({}, { accent: "red" })).toThrow();
    expect(() => applyTokenPatch({}, { fontBody: "Comic Sans MS" })).toThrow();
    expect(() => applyTokenPatch({}, { radius: "13px" })).toThrow();
  });

  it("keeps the theme's own fonts loaded when one font is overridden", () => {
    const base = getTheme("studio").fontHref;
    const merged = mergedFontHref(base, ["Inter"]);
    for (const part of base.split("?")[1].split("&").filter((p) => p.startsWith("family="))) {
      expect(merged).toContain(part);
    }
    expect(merged).toContain("family=Inter:wght@400;500;600;700");
    expect(merged).not.toContain("%3A");
  });

  it("measures contrast and warns below WCAG AA", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    const low = resolveTheme("studio", { accent: "#FFFF00", accentText: "#FFFFFF" });
    expect(contrastWarnings(low).map((w) => w.pair)).toContain("button text on accent");
  });
});

describe("the block registry", () => {
  it("has a renderer for every block type", () => {
    expect([...BLOCKS.keys()].sort()).toEqual([...RENDERED_TYPES].sort());
  });

  it("every insertable block's defaults pass its own schema and form a valid tree", () => {
    for (const def of BLOCKS.values()) {
      if (!def.insertable) continue;
      expect(() => def.schema.parse(def.defaults.props), def.type).not.toThrow();
    }
  });

  it("describes every block as JSON Schema without throwing", () => {
    const described = describeBlocks();
    expect(described.length).toBeGreaterThan(10);
    for (const d of described) {
      expect(d.description.length, d.type).toBeGreaterThan(10);
      expect(d.props).toBeTypeOf("object");
    }
  });

  it("only lets columns hold columns, and sections sit at the top", () => {
    expect(canContain("columns", "column")).toBe(true);
    expect(canContain("columns", "text")).toBe(false);
    expect(canContain("section", "section")).toBe(false);
    expect(canContain("root", "section")).toBe(true);
    expect(canContain("heading", "text")).toBe(false);
    expect(getBlock("root")?.insertable).toBe(false);
  });
});

describe("presets and seeds", () => {
  it("every preset inserts as a valid subtree", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const root = emptyRoot(ids());
      expect(() => insertNodes(root, [{ parentId: root.id, node: preset.node }]), name).not.toThrow();
    }
  });

  it("seeds a home page that matches the fixed storefront", () => {
    const tree = defaultHomeTree({ name: "Aurora Supply", agentDiscovery: true });
    const types = tree.children!.map((s) => s.children!.map((c) => c.type));
    expect(types).toEqual([["heading", "text"], ["productGrid"]]);
    expect(tree.children![0].children![0].props).toEqual({ text: "Aurora Supply", level: 1 });
    expect(checkPage(tree, noCatalog).filter((c) => c.severity === "error")).toEqual([]);
    expect(blankPageTree("About us").children![0].children![0].props.text).toBe("About us");
  });
});

describe("pre-publish checks", () => {
  function tree(children: PageNode["children"]): PageNode {
    return validateTree({ id: "n_0000000000", type: "root", props: {}, children });
  }
  const section = (id: string, children: PageNode[]): PageNode => ({ id, type: "section", props: {}, children });

  it("blocks publishing on an image with no source or a product that does not exist", () => {
    const results = checkPage(
      tree([
        section("n_000000000a", [
          { id: "n_000000000b", type: "heading", props: { text: "Shop", level: 1 } },
          { id: "n_000000000c", type: "image", props: {} },
          { id: "n_000000000d", type: "productCard", props: { productSlug: "ghost" } },
        ]),
      ]),
      { ...noCatalog, productSlugs: new Set(["mug"]) },
    );
    expect(results.filter((r) => r.severity === "error").map((r) => r.code).sort()).toEqual([
      "MISSING_IMAGE_SOURCE",
      "UNKNOWN_PRODUCT",
    ]);
  });

  it("warns on skipped heading levels, missing alt text and placeholders", () => {
    const results = checkPage(
      tree([
        section("n_000000000a", [
          { id: "n_000000000b", type: "heading", props: { text: "Top", level: 1 } },
          { id: "n_000000000c", type: "heading", props: { text: "Deep", level: 4 } },
          { id: "n_000000000d", type: "image", props: { src: "https://cdn.test/a.png" } },
          { id: "n_000000000e", type: "text", props: { markdown: "Tell shoppers something worth knowing." } },
        ]),
      ]),
      noCatalog,
    );
    const codes = results.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["HEADING_SKIP", "MISSING_ALT", "PLACEHOLDER_TEXT"]));
    expect(results.every((r) => r.severity === "warning")).toBe(true);
  });
});

describe("rendering helpers", () => {
  it("resolves site paths against the storefront and drops unsafe links", () => {
    expect(resolveHref("/collections", "https://tea.markii.shop")).toBe("https://tea.markii.shop/collections");
    expect(resolveHref("https://x.test", "https://tea.markii.shop")).toBe("https://x.test");
    expect(resolveHref("javascript:alert(1)", "https://tea.markii.shop")).toBeNull();
  });

  it("publishes FAQ blocks as one FAQPage", () => {
    const t = validateTree({
      id: "n_0000000000",
      type: "root",
      props: {},
      children: [
        {
          id: "n_000000000a",
          type: "section",
          props: {},
          children: [{ id: "n_000000000b", type: "faq", props: { items: [{ question: "Ship?", answer: "Yes, **free**." }] } }],
        },
      ],
    });
    expect(pageJsonLd(t)).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: [{ "@type": "Question", name: "Ship?", acceptedAnswer: { "@type": "Answer", text: "Yes, free." } }],
      },
    ]);
  });
});
