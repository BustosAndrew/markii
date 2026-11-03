import { describe, expect, it } from "vitest";
import type { Category, Product } from "@/lib/db";
import {
  BINDING_PATHS,
  CONDITION_PATHS,
  boundProps,
  conditionSchema,
  describeBindings,
  evaluateCondition,
  scopesFor,
  type DataValues,
} from "./bindings";
import { BLOCKS } from "./blocks";
import { blockingErrors, checkPage, type CatalogFacts } from "./checks";
import {
  DEFAULT_REGION_TREES,
  DEFAULT_TEMPLATE_TREES,
  defaultCollectionTemplate,
  defaultHeaderRegion,
  defaultProductTemplate,
} from "./presets";
import {
  TreeError,
  duplicateNode,
  emptyRoot,
  insertNodes,
  locate,
  nodeInputSchema,
  removeNodes,
  setBindings,
  setVisibility,
  validateTree,
  type IdGenerator,
} from "./tree";
import type { PageNode } from "./types";
import { plainText, productView, storeView } from "./views";

/**
 * M4 — templates, global regions, data bindings, repeaters and conditional
 * visibility. The whitelist is the safety property: a binding or condition is
 * either a path the document will have at render, or an error before publish.
 */

function ids(): IdGenerator {
  let n = 0;
  return () => `n_${String(++n).padStart(10, "0")}`;
}

const noCatalog: CatalogFacts = { productSlugs: new Set(), categorySlugs: new Set(), collectionHandles: new Set() };

function withNode(node: Parameters<typeof insertNodes>[1][number]["node"], parent: "root" | "section" = "section") {
  const id = ids();
  const root = emptyRoot(id);
  if (parent === "root") return insertNodes(root, [{ parentId: root.id, node }], id).root;
  return insertNodes(root, [{ parentId: root.id, node: { type: "section", children: [node] } }], id).root;
}

const store: DataValues["store"] = { name: "Shop", url: "https://s.test/", copyright: "© 2026 Shop", hasCollections: false, productCount: 2 };

describe("bindings in the tree", () => {
  it("keeps a valid binding through validation", () => {
    const tree = withNode({ type: "heading", props: { text: "Name", level: 1 }, bindings: { text: "product.title" } });
    const heading = tree.children![0].children![0];
    expect(heading.bindings).toEqual({ text: "product.title" });
  });

  it("refuses a path that is not on the whitelist", () => {
    expect(() => withNode({ type: "heading", props: { text: "x" }, bindings: { text: "product.secret" } })).toThrow(TreeError);
  });

  it("refuses a prop the block does not let be bound", () => {
    expect(() => withNode({ type: "heading", props: { text: "x" }, bindings: { level: "product.title" } })).toThrow(/cannot bind "level"/);
  });

  it("refuses a path of the wrong type for the prop", () => {
    expect(() => withNode({ type: "heading", props: { text: "x" }, bindings: { text: "product.image" } })).toThrow(/image/);
    expect(() => withNode({ type: "image", bindings: { src: "product.title" } })).toThrow(/text/);
  });

  it("every bindable prop names value types that some path yields", () => {
    const types = new Set(Object.values(BINDING_PATHS).map((p) => p.type));
    for (const def of BLOCKS.values()) {
      for (const [prop, accepts] of Object.entries(def.bindable ?? {})) {
        expect(def.editorPanel.some((f) => f.name === prop) || prop in (def.defaults.props ?? {}), `${def.type}.${prop}`).toBe(true);
        for (const t of accepts) expect(types.has(t), `${def.type}.${prop} → ${t}`).toBe(true);
      }
    }
  });

  it("setBindings reports changes and unbinds with null", () => {
    const tree = withNode({ type: "heading", props: { text: "x" } });
    const id = tree.children![0].children![0].id;
    const bound = setBindings(tree, id, { text: "store.name" });
    expect(bound.changes).toEqual([{ key: "text", before: null, after: "store.name" }]);
    const unbound = setBindings(bound.root, id, { text: null });
    expect(locate(unbound.root, id)!.node.bindings).toBeUndefined();
    expect(unbound.changes[0]).toEqual({ key: "text", before: "store.name", after: null });
  });

  it("survives remove → re-insert (undo) and duplicate", () => {
    const tree = withNode({
      type: "text",
      props: { markdown: "x" },
      bindings: { markdown: "product.description" },
      visibleWhen: { path: "product.description", op: "exists" },
    });
    const section = tree.children![0];
    const textId = section.children![0].id;
    const { root: without, removed } = removeNodes(tree, [textId]);
    const back = insertNodes(without, removed.map((r) => ({ parentId: r.parentId, index: r.index, node: r.node })), ids()).root;
    const restored = locate(back, textId)!.node;
    expect(restored.bindings).toEqual({ markdown: "product.description" });
    expect(restored.visibleWhen).toEqual({ path: "product.description", op: "exists" });

    const dup = duplicateNode(tree, textId, () => "n_dddddddddd");
    expect(locate(dup.root, "n_dddddddddd")!.node.bindings).toEqual({ markdown: "product.description" });
  });

  it("the node input schema carries bindings and conditions (what undo sends back)", () => {
    const parsed = nodeInputSchema.parse({
      type: "heading",
      props: { text: "x" },
      bindings: { text: "item.title" },
      visibleWhen: { path: "item.inStock", op: "eq", value: true },
    });
    expect(parsed.bindings).toEqual({ text: "item.title" });
  });
});

describe("conditions", () => {
  it("validates operator against the path's type", () => {
    expect(conditionSchema.safeParse({ path: "product.stock", op: "gt", value: 0 }).success).toBe(true);
    expect(conditionSchema.safeParse({ path: "product.inStock", op: "gt", value: 0 }).success).toBe(false);
    expect(conditionSchema.safeParse({ path: "product.inStock", op: "eq", value: "yes" }).success).toBe(false);
    expect(conditionSchema.safeParse({ path: "product.stock", op: "gt" }).success).toBe(false);
    expect(conditionSchema.safeParse({ path: "product.description", op: "exists", value: 1 }).success).toBe(false);
    expect(conditionSchema.safeParse({ path: "product.title", op: "exists" }).success).toBe(false);
  });

  const product = {
    slug: "a", title: "A", description: "", price: "$1.00", priceMinor: 100, image: "", url: "", sku: "", stock: 0,
    inStock: false, stockStatus: "Out of stock", category: "", relatedCount: 2,
  };

  it("evaluates the whitelisted comparisons", () => {
    const v: DataValues = { store, product };
    expect(evaluateCondition({ path: "product.stock", op: "gt", value: 0 }, v)).toBe(false);
    expect(evaluateCondition({ path: "product.stock", op: "lte", value: 0 }, v)).toBe(true);
    expect(evaluateCondition({ path: "product.description", op: "exists" }, v)).toBe(false);
    expect(evaluateCondition({ path: "product.description", op: "missing" }, v)).toBe(true);
    expect(evaluateCondition({ path: "product.inStock", op: "eq", value: false }, v)).toBe(true);
    expect(evaluateCondition({ path: "product.relatedCount", op: "gte", value: 2 }, v)).toBe(true);
    expect(evaluateCondition({ path: "store.hasCollections", op: "neq", value: true }, v)).toBe(true);
  });

  it("answers null — not false — where the scope does not exist", () => {
    expect(evaluateCondition({ path: "product.stock", op: "gt", value: 0 }, { store })).toBeNull();
    expect(evaluateCondition({ path: "item.inStock", op: "eq", value: true }, { store, product })).toBeNull();
  });

  it("every condition path is on a real scope and well described", () => {
    for (const [path, spec] of Object.entries(CONDITION_PATHS)) expect(path.startsWith(`${spec.scope}.`), path).toBe(true);
    const listed = describeBindings();
    expect(listed.bindings.map((b) => b.path).sort()).toEqual(Object.keys(BINDING_PATHS).sort());
    expect(listed.conditions.map((b) => b.path).sort()).toEqual(Object.keys(CONDITION_PATHS).sort());
  });

  it("setVisibility refuses the root and reports whether anything changed", () => {
    const tree = withNode({ type: "text", props: { markdown: "x" } });
    expect(() => setVisibility(tree, tree.id, { path: "store.productCount", op: "gt", value: 0 })).toThrow(TreeError);
    const id = tree.children![0].children![0].id;
    const set = setVisibility(tree, id, { path: "store.productCount", op: "gt", value: 0 });
    expect(set.changed).toBe(true);
    expect(setVisibility(set.root, id, { path: "store.productCount", op: "gt", value: 0 }).changed).toBe(false);
    expect(setVisibility(set.root, id, null).before).toEqual({ path: "store.productCount", op: "gt", value: 0 });
  });
});

describe("binding values", () => {
  it("fills bound props and keeps the placeholder where the data is empty", () => {
    const node: PageNode = { id: "n_0000000001", type: "heading", props: { text: "Placeholder" }, bindings: { text: "product.title" } };
    expect(boundProps(node, { store }).text).toBe("Placeholder");
    const v: DataValues = { store, product: { ...({} as DataValues["product"])!, title: "  " } };
    expect(boundProps(node, v).text).toBe("Placeholder");
    expect(boundProps(node, { store, product: { ...v.product!, title: "Real" } }).text).toBe("Real");
  });

  it("product views carry text only, and count enabled related products", () => {
    const base = { categoryId: 1, currency: "USD", sku: null, images: [], enabled: true } as unknown as Product;
    const a = { ...base, id: 1, slug: "a", name: "A", description: "<p>Soft <b>wool</b></p>", priceCents: 1500, stock: 3, suggestedProductIds: [2, 3] } as Product;
    const b = { ...base, id: 2, slug: "b", name: "B", description: null, priceCents: 100, stock: 0, suggestedProductIds: [] } as unknown as Product;
    const c = { ...b, id: 3, slug: "c", enabled: false } as Product;
    const cats = [{ id: 1, name: "Knits" } as Category];
    const view = productView(a, { baseUrl: "https://s.test/", categories: cats, products: [a, b, c] });
    expect(view.description).toBe("Soft wool");
    expect(view.price).toBe("$15.00");
    expect(view.stockStatus).toBe("3 in stock");
    expect(view.url).toBe("https://s.test/p/a");
    expect(view.category).toBe("Knits");
    expect(view.relatedCount).toBe(1);
    expect(productView(b, { baseUrl: "https://s.test", categories: [], products: [a, b] }).stockStatus).toBe("Out of stock");
    expect(plainText("<script>x</script>y")).toBe("x y");
    expect(storeView({ name: "Shop" }, { baseUrl: "https://s.test", products: [a, c], collections: [] }, new Date("2026-03-01")).copyright).toBe("© 2026 Shop");
  });
});

describe("repeaters", () => {
  it("may not nest", () => {
    expect(() =>
      withNode({ type: "repeater", children: [{ type: "repeater", children: [{ type: "text", props: { markdown: "x" } }] }] }),
    ).toThrow(/another repeater/);
  });

  it("item bindings are fine inside one and an error outside", () => {
    const inside = withNode({ type: "repeater", children: [{ type: "heading", props: { text: "x", level: 2 }, bindings: { text: "item.title" } }] });
    expect(checkPage(inside, noCatalog, "home").filter((r) => r.code === "UNAVAILABLE_BINDING")).toEqual([]);
    const outside = withNode({ type: "heading", props: { text: "x", level: 2 }, bindings: { text: "item.title" } });
    expect(checkPage(outside, noCatalog, "home").map((r) => r.code)).toContain("UNAVAILABLE_BINDING");
  });

  it("a source the document does not have is an error", () => {
    const tree = withNode({ type: "repeater", props: { source: "product.related" }, children: [{ type: "text", props: { markdown: "x" } }] });
    expect(blockingErrors(checkPage(tree, noCatalog, "home")).map((r) => r.code)).toContain("UNAVAILABLE_SOURCE");
    expect(blockingErrors(checkPage(tree, noCatalog, "product", "template")).map((r) => r.code)).not.toContain("UNAVAILABLE_SOURCE");
  });
});

describe("templates and regions", () => {
  it("every default tree is valid and publishes without errors", () => {
    for (const [handle, make] of Object.entries(DEFAULT_TEMPLATE_TREES)) {
      const tree = make(ids());
      expect(validateTree(tree)).toEqual(tree);
      expect(blockingErrors(checkPage(tree, noCatalog, handle, "template")), handle).toEqual([]);
    }
    for (const [handle, make] of Object.entries(DEFAULT_REGION_TREES)) {
      const tree = make(ids());
      expect(validateTree(tree)).toEqual(tree);
      expect(blockingErrors(checkPage(tree, noCatalog, handle, "region")), handle).toEqual([]);
    }
  });

  it("the product template reproduces the fixed page: bound name, buy block, related products", () => {
    const tree = defaultProductTemplate(ids());
    const all: PageNode[] = [];
    const walk = (n: PageNode) => {
      all.push(n);
      (n.children ?? []).forEach(walk);
    };
    walk(tree);
    expect(all.find((n) => n.type === "heading" && n.props.level === 1)?.bindings).toEqual({ text: "product.title" });
    expect(all.filter((n) => n.type === "productBuy")).toHaveLength(1);
    expect(all.find((n) => n.type === "repeater")?.props.source).toBe("product.related");
    expect(all.find((n) => n.intent === "related products")?.visibleWhen).toEqual({ path: "product.relatedCount", op: "gt", value: 0 });
  });

  it("a product template without a Buy block cannot publish", () => {
    const tree = defaultProductTemplate(ids());
    const buy: string[] = [];
    const walk = (n: PageNode) => {
      if (n.type === "productBuy") buy.push(n.id);
      (n.children ?? []).forEach(walk);
    };
    walk(tree);
    const { root } = removeNodes(tree, buy);
    expect(blockingErrors(checkPage(root, noCatalog, "product", "template")).map((r) => r.code)).toEqual(["MISSING_BUY_BLOCK"]);
  });

  it("product-only blocks and bindings are errors on a page, and on the other template", () => {
    const tree = defaultProductTemplate(ids());
    const onPage = blockingErrors(checkPage(tree, noCatalog, "home", "page")).map((r) => r.code);
    expect(onPage).toContain("BLOCK_NEEDS_TEMPLATE");
    expect(onPage).toContain("UNAVAILABLE_BINDING");
    expect(onPage).toContain("UNAVAILABLE_CONDITION");
    const onCollection = blockingErrors(checkPage(tree, noCatalog, "collection", "template")).map((r) => r.code);
    expect(onCollection).toContain("BLOCK_NEEDS_TEMPLATE");
    const grid = blockingErrors(checkPage(defaultCollectionTemplate(ids()), noCatalog, "about", "page")).map((r) => r.code);
    expect(grid).toContain("UNAVAILABLE_SOURCE");
  });

  it("a region is not a page: no outline checks, and sections need no label", () => {
    const codes = checkPage(defaultHeaderRegion(ids()), noCatalog, "header", "region").map((r) => r.code);
    expect(codes).not.toContain("NO_H1");
    expect(codes).not.toContain("SECTION_UNLABELLED");
    const results = checkPage(defaultHeaderRegion(ids()), noCatalog, "header", "region");
    for (const r of results) expect(r.kind).toBe("region");
  });

  it("scopes follow the document", () => {
    expect([...scopesFor("page", "home")]).toEqual(["store"]);
    expect([...scopesFor("template", "product")].sort()).toEqual(["product", "store"]);
    expect([...scopesFor("template", "collection")].sort()).toEqual(["collection", "store"]);
    expect([...scopesFor("region", "header")]).toEqual(["store"]);
  });
});
