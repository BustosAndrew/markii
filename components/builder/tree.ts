import type { BlockDescription, PageNode } from "@/lib/api/builder";

/**
 * Read-only tree helpers for the editor. **Pure and client-safe** — the
 * server's `lib/builder/tree.ts` imports `node:crypto` and stays there. The
 * editor never changes a tree itself: every edit is a registry action, and the
 * tree is re-read from the API afterwards.
 */

export type Found = { node: PageNode; parent: PageNode | null; index: number; depth: number };

export function find(root: PageNode, id: string | null): Found | null {
  if (!id) return null;
  const visit = (node: PageNode, parent: PageNode | null, index: number, depth: number): Found | null => {
    if (node.id === id) return { node, parent, index, depth };
    const kids = node.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const hit = visit(kids[i], node, i, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return visit(root, null, 0, 0);
}

export function contains(ancestor: PageNode, id: string): boolean {
  return (ancestor.children ?? []).some((c) => c.id === id || contains(c, id));
}

/** Whether a block of `childType` may sit directly inside a block of `parentType` — mirrors the registry. */
export function accepts(registry: Map<string, BlockDescription>, parentType: string, childType: string): boolean {
  if (childType === "root") return false;
  const child = registry.get(childType);
  if (child?.parents && !child.parents.includes(parentType)) return false;
  if (parentType === "root") return true; // the root accepts any block
  const parent = registry.get(parentType);
  if (!parent || parent.children === "none") return false;
  if (parent.children === "any") return true;
  return parent.children.includes(childType);
}

/**
 * Where a new block goes: inside the selection when it can hold the block,
 * otherwise right after it, otherwise at the end of the page.
 */
export function insertionPoint(
  root: PageNode,
  selectedId: string | null,
  type: string,
  registry: Map<string, BlockDescription>,
): { parentId: string; index?: number } | null {
  const sel = find(root, selectedId);
  if (sel && accepts(registry, sel.node.type, type)) return { parentId: sel.node.id };
  if (sel?.parent && accepts(registry, sel.parent.type, type)) return { parentId: sel.parent.id, index: sel.index + 1 };
  // Walk up from the selection to the first ancestor that takes it.
  if (sel) {
    let cursor: Found | null = sel;
    while (cursor?.parent) {
      const up = find(root, cursor.parent.id);
      if (up?.parent && accepts(registry, up.parent.type, type)) return { parentId: up.parent.id, index: up.index + 1 };
      cursor = up;
    }
  }
  return accepts(registry, "root", type) ? { parentId: root.id } : null;
}

/** A short human label for a node in the layer tree. */
export function nodeLabel(node: PageNode, registry: Map<string, BlockDescription>): string {
  const base = registry.get(node.type)?.label ?? (node.type === "root" ? "Page" : node.type);
  const p = node.props as Record<string, unknown>;
  const text =
    (typeof p.text === "string" && p.text) ||
    (typeof p.label === "string" && p.label) ||
    (typeof p.markdown === "string" &&
      p.markdown
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → their text
        .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, "") // list markers
        .replace(/[*_`]/g, "")
        .trim()) ||
    (typeof p.quote === "string" && p.quote) ||
    node.intent ||
    "";
  return text ? `${base} · ${text.slice(0, 40)}` : base;
}
