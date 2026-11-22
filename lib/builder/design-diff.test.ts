import { describe, expect, it } from "vitest";
import type { PageNode } from "@markii/renderer/types";
import { DIFF_VALUE_MAX, diffDesigns, type DesignSnapshot } from "./design-diff";

/** §12 version diff — pure, so every case is two snapshots in and one answer out. */

const n = (id: string, type: string, props: Record<string, unknown> = {}, children?: PageNode[]): PageNode => ({
  id: `n_${id.padStart(10, "0")}`,
  type,
  props,
  ...(children ? { children } : {}),
});

function home(children: PageNode[]): DesignSnapshot["documents"][number] {
  return { id: 1, kind: "page", handle: "home", title: "Home", seo: {}, tree: n("root", "root", {}, children) };
}

function snap(documents: DesignSnapshot["documents"], over: Partial<DesignSnapshot> = {}): DesignSnapshot {
  return { themeId: "studio", tokens: {}, customCss: "", headHtml: "", documents, ...over };
}

const hero = () => n("hero", "section", {}, [n("h1", "heading", { text: "Hello", level: 1 }), n("body", "text", { text: "Welcome" })]);

describe("diffDesigns", () => {
  it("finds nothing between a design and itself, whatever order its keys were stored in", () => {
    const a = snap([home([hero()])], { tokens: { accent: "#C9184A", radius: "6px" } });
    const b = snap([home([hero()])], { tokens: { radius: "6px", accent: "#C9184A" } });
    const d = diffDesigns(a, b);
    expect(d.identical).toBe(true);
    expect(d.documents).toEqual([]);
  });

  it("names a changed prop with both values, and only that node", () => {
    const after = hero();
    after.children![0].props = { text: "Hello there", level: 1 };
    const d = diffDesigns(snap([home([hero()])]), snap([home([after])]));
    expect(d.identical).toBe(false);
    expect(d.documents).toHaveLength(1);
    expect(d.documents[0].change).toBe("changed");
    expect(d.documents[0].nodes.changed).toEqual([
      { id: "n_00000000h1", type: "heading", label: "Heading", changes: [{ field: "props.text", before: "Hello", after: "Hello there" }] },
    ]);
    expect(d.summary).toMatchObject({ nodesChanged: 1, nodesAdded: 0, nodesRemoved: 0 });
  });

  it("does not call every block below an insertion moved", () => {
    const before = home([n("a", "text"), n("b", "text"), n("c", "text")]);
    const after = home([n("new", "divider"), n("a", "text"), n("b", "text"), n("c", "text")]);
    const d = diffDesigns(snap([before]), snap([after]));
    expect(d.documents[0].nodes.added.map((x) => x.id)).toEqual(["n_0000000new"]);
    expect(d.documents[0].nodes.changed).toEqual([]);
  });

  it("reports a reorder as the fewest moves that explain it", () => {
    const before = home([n("a", "text"), n("b", "text"), n("c", "text")]);
    const after = home([n("b", "text"), n("c", "text"), n("a", "text")]);
    const d = diffDesigns(snap([before]), snap([after]));
    expect(d.documents[0].nodes.changed.map((x) => [x.id, x.changes.map((c) => c.field)])).toEqual([["n_000000000a", ["moved"]]]);
  });

  it("reports a node moved into another parent", () => {
    const before = home([n("s", "section", {}, []), n("t", "text")]);
    const after = home([n("s", "section", {}, [n("t", "text")])]);
    const d = diffDesigns(snap([before]), snap([after]));
    expect(d.documents[0].nodes.changed).toEqual([
      expect.objectContaining({ id: "n_000000000t", changes: [{ field: "moved", before: "n_000000root", after: "n_000000000s" }] }),
    ]);
  });

  it("lists every block of an added or removed page, not the page's root", () => {
    const about = { id: 2, kind: "page", handle: "about", title: "About", seo: {}, tree: n("r2", "root", {}, [n("x", "text")]) };
    const added = diffDesigns(snap([home([])]), snap([home([]), about]));
    expect(added.documents).toEqual([expect.objectContaining({ id: 2, change: "added", nodes: { added: [expect.objectContaining({ id: "n_000000000x" })], removed: [], changed: [] } })]);
    const removed = diffDesigns(snap([home([]), about]), snap([home([])]));
    expect(removed.documents[0]).toMatchObject({ id: 2, change: "removed", handle: "about" });
    expect(removed.summary).toMatchObject({ documentsRemoved: 1, nodesRemoved: 1 });
  });

  it("names page fields, theme, tokens, theme CSS and scripts — scripts without their text", () => {
    const before = snap([home([])], { tokens: { accent: "#000000" }, customCss: ".a{}", headHtml: "<script>one()</script>" });
    const page = home([]);
    page.title = "Welcome";
    page.seo = { description: "A shop", noindex: true };
    const after = snap([page], { themeId: "market", tokens: { accent: "#ffffff", radius: "12px" }, customCss: ".a{color:red}", headHtml: "<script>two()</script>" });
    const d = diffDesigns(before, after);
    expect(d.theme).toEqual({ before: "studio", after: "market" });
    expect(d.tokens).toEqual([
      { field: "accent", before: "#000000", after: "#ffffff" },
      { field: "radius", before: null, after: "12px" },
    ]);
    expect(d.customCss).toEqual({ before: 4, after: 13 });
    expect(d.headCode).toEqual({ changed: true });
    expect(JSON.stringify(d)).not.toContain("two()");
    expect(d.documents[0].fields).toEqual([
      { field: "title", before: "Home", after: "Welcome" },
      { field: "seo.description", before: null, after: "A shop" },
      { field: "seo.noindex", before: null, after: true },
    ]);
  });

  it("reads a snapshot from before custom CSS and scripts existed as having none", () => {
    const old: DesignSnapshot = { themeId: "studio", tokens: {}, documents: [home([])] };
    expect(diffDesigns(old, snap([home([])])).identical).toBe(true);
  });

  it("cuts long values instead of reprinting them", () => {
    const long = "x".repeat(DIFF_VALUE_MAX * 3);
    const d = diffDesigns(snap([home([n("t", "text", { text: "short" })])]), snap([home([n("t", "text", { text: long })])]));
    const after = d.documents[0].nodes.changed[0].changes[0].after as string;
    expect(after.length).toBe(DIFF_VALUE_MAX + 1);
    expect(after.endsWith("…")).toBe(true);
  });

  it("covers bindings, visibility, custom classes and per-breakpoint styles", () => {
    const before = n("t", "text", { text: "a" });
    const after: PageNode = {
      ...n("t", "text", { text: "a" }),
      bindings: { text: "product.title" },
      visibleWhen: { path: "product.available", op: "exists" },
      customClass: "promo",
      styles: { md: { padding: "lg" } as never },
    };
    const d = diffDesigns(snap([home([before])]), snap([home([after])]));
    expect(d.documents[0].nodes.changed[0].changes.map((c) => c.field)).toEqual(["styles.md", "bindings", "visibleWhen", "customClass"]);
  });
});
