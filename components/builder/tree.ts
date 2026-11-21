import type { BlockDescription, Breakpoint, NodeInput, PageNode, StyleProps } from "@/lib/api/builder";
import { scopesFor } from "@markii/renderer/bindings";
import type { DocumentKind } from "@markii/renderer/types";

/**
 * Read-only tree helpers for the editor. **Pure and client-safe** — the
 * server's `packages/renderer/src/tree.ts` imports `node:crypto` and stays there. The
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

/** Whether a node sits somewhere inside a repeater — where `item.*` bindings exist (M4). */
export function insideRepeater(root: PageNode, id: string): boolean {
  const visit = (node: PageNode, inRepeater: boolean): boolean | null => {
    if (node.id === id) return inRepeater;
    for (const c of node.children ?? []) {
      const hit = visit(c, inRepeater || node.type === "repeater");
      if (hit !== null) return hit;
    }
    return null;
  };
  return visit(root, false) ?? false;
}

/**
 * The data scopes a selected node can bind to: what its document renders with
 * (the server's own `scopesFor` — the module is pure), plus `item` inside a
 * repeater.
 */
export function nodeScopes(doc: { kind: DocumentKind; handle: string } | null, root: PageNode | null, nodeId: string | null): string[] {
  const scopes = [...scopesFor(doc?.kind ?? "page", doc?.handle ?? "")];
  if (root && nodeId && insideRepeater(root, nodeId)) scopes.push("item");
  return scopes;
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

// ---------- M7: selections, copy/paste, bulk edits, breakpoints ----------

/** Every node id in document order (the order the layer tree lists them). */
export function docOrder(root: PageNode): string[] {
  const out: string[] = [];
  const walk = (n: PageNode) => {
    out.push(n.id);
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * The selection a bulk edit acts on: ids still in the tree, never the root, a
 * node inside another selected node dropped (it travels with its ancestor),
 * in document order.
 */
export function outermost(root: PageNode, ids: string[]): string[] {
  const wanted = new Set(ids);
  const out: string[] = [];
  const walk = (n: PageNode, covered: boolean) => {
    const take = !covered && n.type !== "root" && wanted.has(n.id);
    if (take) out.push(n.id);
    (n.children ?? []).forEach((c) => walk(c, covered || take));
  };
  walk(root, false);
  return out;
}

/** The client's copy of the server's `nodeToInput`: a subtree without ids, ready to insert. */
export function toInput(n: PageNode): NodeInput {
  const out: NodeInput = { type: n.type, props: structuredClone(n.props) };
  if (n.styles && Object.keys(n.styles).length) out.styles = structuredClone(n.styles);
  if (n.intent) out.intent = n.intent;
  if (n.bindings && Object.keys(n.bindings).length) out.bindings = { ...n.bindings };
  if (n.visibleWhen) out.visibleWhen = { ...n.visibleWhen };
  if (n.customClass) out.customClass = n.customClass;
  if (n.children) out.children = n.children.map(toInput);
  return out;
}

export type Move = { nodeId: string; parentId: string; index: number };

/**
 * The `builder.moveNodes` list that puts the selected nodes, in document
 * order, side by side in `parentId` starting at slot `index` — the slot before
 * the child that is at `index` *now*. Simulated on a copy so each index is the
 * one the server will see after the moves before it (which shift siblings).
 * Returns null when a node would land inside itself.
 */
export function planBulkMove(root: PageNode, ids: string[], parentId: string, index: number): Move[] | null {
  const tree = structuredClone(root);
  const order = outermost(tree, ids);
  if (order.some((id) => id === parentId || contains(find(tree, id)!.node, parentId))) return null;
  const moves: Move[] = [];
  let cursor = index;
  for (const id of order) {
    const at = find(tree, id)!;
    if (at.parent!.id === parentId && at.index < cursor) cursor -= 1;
    at.parent!.children = at.parent!.children!.filter((c) => c.id !== id);
    const target = find(tree, parentId)!.node;
    const kids = (target.children ??= []);
    cursor = Math.max(0, Math.min(cursor, kids.length));
    kids.splice(cursor, 0, at.node);
    moves.push({ nodeId: id, parentId, index: cursor });
    cursor += 1;
  }
  return moves;
}

/**
 * Alt+↑/↓ on a selection: the whole group steps one place among its siblings.
 * Only when every selected block shares a parent; null when it cannot move.
 */
export function planGroupStep(root: PageNode, ids: string[], dir: -1 | 1): Move[] | null {
  const order = outermost(root, ids);
  if (order.length === 0) return null;
  const spots = order.map((id) => find(root, id)!);
  const parent = spots[0].parent!;
  if (spots.some((s) => s.parent!.id !== parent.id)) return null;
  const first = Math.min(...spots.map((s) => s.index));
  const last = Math.max(...spots.map((s) => s.index));
  const count = parent.children!.length;
  if (dir === -1 ? first === 0 : last === count - 1) return null;
  return planBulkMove(root, order, parent.id, dir === -1 ? first - 1 : last + 2);
}

/** Copies of the selected blocks, each right after its original, as one `insertNodes`. */
export function planDuplicate(root: PageNode, ids: string[]): { parentId: string; index: number; node: NodeInput }[] {
  // Last first: inserting after a later block never shifts an earlier one.
  return outermost(root, ids)
    .reverse()
    .map((id) => {
      const at = find(root, id)!;
      return { parentId: at.parent!.id, index: at.index + 1, node: toInput(at.node) };
    });
}

/**
 * Where pasted blocks go: each where a new block of its type would
 * (`insertionPoint`), keeping their order. Null when one of them fits nowhere.
 */
export function planPaste(
  root: PageNode,
  selectedId: string | null,
  nodes: NodeInput[],
  registry: Map<string, BlockDescription>,
): { parentId: string; index?: number; node: NodeInput }[] | null {
  const placed = new Map<string, number>();
  const out: { parentId: string; index?: number; node: NodeInput }[] = [];
  for (const node of nodes) {
    const at = insertionPoint(root, selectedId, node.type, registry);
    if (!at) return null;
    const key = `${at.parentId}:${at.index ?? "end"}`;
    const n = placed.get(key) ?? 0;
    placed.set(key, n + 1);
    out.push({ parentId: at.parentId, ...(at.index === undefined ? {} : { index: at.index + n }), node });
  }
  return out;
}

export const BREAKPOINT_ORDER: Breakpoint[] = ["base", "sm", "md", "lg"];

/**
 * What a style resolves to at a breakpoint when it is not set there: the
 * nearest smaller breakpoint that sets it (styles are mobile-first, so each
 * size inherits from the sizes below it). `from` is null when nothing sets it
 * and the block's own default applies.
 */
export function inheritedStyle(
  styles: PageNode["styles"],
  breakpoint: Breakpoint,
  key: keyof StyleProps,
): { value: unknown; from: Breakpoint | null } {
  const below = BREAKPOINT_ORDER.slice(0, BREAKPOINT_ORDER.indexOf(breakpoint)).reverse();
  for (const bp of below) {
    const v = (styles?.[bp] as Record<string, unknown> | undefined)?.[key as string];
    if (v !== undefined) return { value: v, from: bp };
  }
  return { value: undefined, from: null };
}
