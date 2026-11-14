import { describe, expect, it } from "vitest";
import type { BlockDescription } from "@/lib/api/builder";
import { inheritedStyle, outermost, planBulkMove, planDuplicate, planGroupStep, planPaste, toInput } from "@/components/builder/tree";
import { describeBlocks } from "./blocks";
import { normalizeSavedBlock } from "./saved-blocks";
import { TreeError, emptyRoot, insertNodes, moveNodes, nodeToInput, type IdGenerator } from "./tree";
import type { PageNode } from "./types";

/**
 * M7 — the editor's bulk edits. The editor plans them on its own copy of the
 * tree and the server applies them to the real one, so the two must agree to
 * the index: every plan here is run through the server's own operations and
 * the result checked, rather than trusting the client's arithmetic.
 */

function ids(): IdGenerator {
  let n = 0;
  return () => `n_${String(++n).padStart(10, "0")}`;
}

/** root > section > [A, B, C, D] headings, and a second section with [E]. */
function page() {
  const id = ids();
  const root = emptyRoot(id);
  const h = (text: string) => ({ type: "heading", props: { text } });
  return insertNodes(
    root,
    [
      { parentId: root.id, node: { type: "section", children: [h("A"), h("B"), h("C"), h("D")] } },
      { parentId: root.id, node: { type: "section", children: [h("E")] } },
    ],
    id,
  ).root;
}

const texts = (n: PageNode) => (n.children ?? []).map((c) => String((c.props as { text?: string }).text));
const byText = (root: PageNode, t: string): string => {
  let hit = "";
  const walk = (n: PageNode) => {
    if ((n.props as { text?: string }).text === t) hit = n.id;
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return hit;
};

const registry = new Map<string, BlockDescription>(describeBlocks().map((b) => [b.type, b as unknown as BlockDescription]));

describe("bulk move: the client's plan is what the server does", () => {
  it("steps a group down and back up, and the reversed list undoes it", () => {
    const root = page();
    const [s1] = root.children!;
    const sel = [byText(root, "A"), byText(root, "B")];

    const down = planGroupStep(root, sel, 1)!;
    const after = moveNodes(root, down);
    expect(texts(after.root.children![0])).toEqual(["C", "A", "B", "D"]);

    // The inverse `builder.moveNodes` builds: the moves reversed, each back to where it came from.
    const undo = moveNodes(after.root, [...after.moved].reverse().map((m) => ({ nodeId: m.nodeId, parentId: m.from.parentId, index: m.from.index })));
    expect(undo.root).toEqual(root);
    expect(s1.id).toBe(after.root.children![0].id);
  });

  it("moves blocks from different places together, in document order", () => {
    const root = page();
    const s2 = root.children![1];
    const plan = planBulkMove(root, [byText(root, "D"), byText(root, "B")], s2.id, 0)!;
    const out = moveNodes(root, plan).root;
    expect(texts(out.children![0])).toEqual(["A", "C"]);
    expect(texts(out.children![1])).toEqual(["B", "D", "E"]);
  });

  it("will not step past the edge, mix parents, or nest a block in itself", () => {
    const root = page();
    expect(planGroupStep(root, [byText(root, "A")], -1)).toBeNull();
    expect(planGroupStep(root, [byText(root, "D")], 1)).toBeNull();
    expect(planGroupStep(root, [byText(root, "A"), byText(root, "E")], 1)).toBeNull();
    const s1 = root.children![0];
    expect(planBulkMove(root, [s1.id], s1.id, 0)).toBeNull();
  });

  it("acts on outermost blocks only — a child selected with its section travels with it", () => {
    const root = page();
    const s1 = root.children![0];
    expect(outermost(root, [byText(root, "B"), s1.id, root.id])).toEqual([s1.id]);
  });
});

describe("duplicate and paste land where the editor says", () => {
  it("puts each copy right after its original, in one insert", () => {
    const root = page();
    const placements = planDuplicate(root, [byText(root, "A"), byText(root, "C")]);
    const out = insertNodes(root, placements, ids()).root;
    expect(texts(out.children![0])).toEqual(["A", "A", "B", "C", "C", "D"]);
  });

  it("pastes after the selection, keeping the copied order", () => {
    const root = page();
    const nodes = [byText(root, "A"), byText(root, "B")].map((id) => toInput(root.children![0].children!.find((c) => c.id === id)!));
    const placements = planPaste(root, byText(root, "E"), nodes, registry)!;
    const out = insertNodes(root, placements, ids()).root;
    expect(texts(out.children![1])).toEqual(["E", "A", "B"]);
  });

  it("strips ids, so a paste never collides with what it was copied from", () => {
    const root = page();
    const input = toInput(root.children![0]);
    expect(JSON.stringify(input)).not.toMatch(/"id"/);
    expect(input).toEqual(nodeToInput(root.children![0]));
  });
});

describe("saved blocks are stored as clean input", () => {
  it("keeps the subtree, drops ids, and counts its blocks", () => {
    const root = page();
    const { node, nodeCount } = normalizeSavedBlock(nodeToInput(root.children![0]));
    expect(nodeCount).toBe(5);
    expect(JSON.stringify(node)).not.toMatch(/"id"/);
    expect(node.children?.map((c) => (c.props as { text?: string }).text)).toEqual(["A", "B", "C", "D"]);
  });

  it("rebuilds custom HTML from the allowlist on save", () => {
    const { node } = normalizeSavedBlock({ type: "section", children: [{ type: "html", props: { html: '<p onclick="x()">Hi</p><script>bad()</script>' } }] });
    expect(node.children?.[0].props?.html).toBe("<p>Hi</p>");
  });

  it("refuses what an insert would refuse", () => {
    expect(() => normalizeSavedBlock({ type: "nope" })).toThrow(TreeError);
    expect(() => normalizeSavedBlock({ type: "column" })).toThrow(TreeError);
  });
});

describe("breakpoint inheritance in the inspector", () => {
  const styles = { base: { paddingY: "lg" as const }, md: { paddingY: "sm" as const, color: "accent" as const } };
  it("inherits from the nearest smaller size that sets the style", () => {
    expect(inheritedStyle(styles, "sm", "paddingY")).toEqual({ value: "lg", from: "base" });
    expect(inheritedStyle(styles, "lg", "paddingY")).toEqual({ value: "sm", from: "md" });
    expect(inheritedStyle(styles, "lg", "color")).toEqual({ value: "accent", from: "md" });
    expect(inheritedStyle(styles, "md", "gap")).toEqual({ value: undefined, from: null });
    expect(inheritedStyle(styles, "base", "paddingY")).toEqual({ value: undefined, from: null });
  });
});
