import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BLOCKS, canContain, getBlock } from "./blocks";
import { nodeStylesSchema, styleSchema } from "./styles";
import {
  NODE_ID_PATTERN,
  TREE_LIMITS,
  type Breakpoint,
  type NodeStyles,
  type PageNode,
  type StyleProps,
} from "./types";

/**
 * Pure operations on a page tree (D51).
 *
 * Every builder action is a thin wrapper over one of these: load the draft,
 * apply the operation, `validateTree`, save. Keeping them pure is what makes
 * them exhaustively testable, and what makes each action's inverse checkable
 * without a database.
 *
 * Operations never mutate their input; each returns a new root.
 */

export class TreeError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "LIMIT",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type IdGenerator = () => string;

export const randomNodeId: IdGenerator = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(10);
  let id = "n_";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export type Located = { node: PageNode; parent: PageNode | null; index: number; depth: number };

export function locate(root: PageNode, id: string): Located | null {
  const visit = (node: PageNode, parent: PageNode | null, index: number, depth: number): Located | null => {
    if (node.id === id) return { node, parent, index, depth };
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const hit = visit(children[i], node, i, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return visit(root, null, 0, 0);
}

function mustLocate(root: PageNode, id: string): Located {
  const hit = locate(root, id);
  if (!hit) throw new TreeError("NOT_FOUND", `No node "${id}" on this page. Read the page again for current ids.`, { nodeId: id });
  return hit;
}

export function countNodes(node: PageNode): number {
  return 1 + (node.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

function isDescendant(ancestor: PageNode, id: string): boolean {
  return (ancestor.children ?? []).some((c) => c.id === id || isDescendant(c, id));
}

// ---------- validation ----------

function issuesOf(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join(".") || "props"}: ${i.message}`).join("; ");
  return e instanceof Error ? e.message : String(e);
}

/**
 * The whole tree is valid: one root, known types, legal nesting, each node's
 * props and styles passing its block's schema, unique well-formed ids, and
 * within the size limits. Returns the tree with every block's defaults applied.
 */
export function validateTree(root: PageNode): PageNode {
  if (root.type !== "root") throw new TreeError("INVALID", "A page's top node must be the root.");
  const seen = new Set<string>();
  let total = 0;

  const check = (node: PageNode, parentType: string | null, depth: number): PageNode => {
    total += 1;
    if (total > TREE_LIMITS.maxNodes) {
      throw new TreeError("LIMIT", `A page may hold at most ${TREE_LIMITS.maxNodes} blocks.`);
    }
    if (depth > TREE_LIMITS.maxDepth) {
      throw new TreeError("LIMIT", `Blocks may nest at most ${TREE_LIMITS.maxDepth} deep.`);
    }
    if (!NODE_ID_PATTERN.test(node.id)) throw new TreeError("INVALID", `"${node.id}" is not a valid node id.`);
    if (seen.has(node.id)) throw new TreeError("INVALID", `Node id "${node.id}" is used twice.`);
    seen.add(node.id);

    const def = getBlock(node.type);
    if (!def) {
      throw new TreeError("INVALID", `Unknown block type "${node.type}". Known: ${[...BLOCKS.keys()].join(", ")}.`);
    }
    if (parentType !== null && !canContain(parentType, node.type)) {
      throw new TreeError("INVALID", `A ${node.type} block cannot go inside a ${parentType}.`, {
        nodeId: node.id,
        parentType,
      });
    }

    let props: Record<string, unknown>;
    try {
      props = def.schema.parse(node.props ?? {}) as Record<string, unknown>;
    } catch (e) {
      throw new TreeError("INVALID", `Invalid ${node.type} (${node.id}): ${issuesOf(e)}`, { nodeId: node.id });
    }
    if (JSON.stringify(props).length > TREE_LIMITS.maxPropsBytes) {
      throw new TreeError("LIMIT", `The ${node.type} block ${node.id} holds too much content; split it up.`);
    }

    let styles: NodeStyles | undefined;
    if (node.styles && Object.keys(node.styles).length > 0) {
      try {
        styles = nodeStylesSchema.parse(node.styles) as NodeStyles;
      } catch (e) {
        throw new TreeError("INVALID", `Invalid styles on ${node.id}: ${issuesOf(e)}`, { nodeId: node.id });
      }
    }

    if (node.intent !== undefined && node.intent.length > TREE_LIMITS.maxIntentLength) {
      throw new TreeError("INVALID", `An intent note is at most ${TREE_LIMITS.maxIntentLength} characters.`);
    }

    const children = node.children ?? [];
    if (def.children === "none" && children.length > 0) {
      throw new TreeError("INVALID", `A ${node.type} block cannot hold other blocks.`, { nodeId: node.id });
    }
    if (def.maxChildren !== undefined && children.length > def.maxChildren) {
      throw new TreeError("LIMIT", `A ${node.type} block holds at most ${def.maxChildren} children.`, { nodeId: node.id });
    }

    const out: PageNode = { id: node.id, type: node.type, props };
    if (styles) out.styles = styles;
    if (node.intent) out.intent = node.intent;
    if (def.children !== "none") out.children = children.map((c) => check(c, node.type, depth + 1));
    return out;
  };

  return check(root, null, 0);
}

/** An empty page. */
export function emptyRoot(id: IdGenerator = randomNodeId): PageNode {
  return { id: id(), type: "root", props: {}, children: [] };
}

// ---------- building nodes from input ----------

/** What a caller may send for a new node: ids optional, props merged over the block's defaults. */
export type NodeInput = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  styles?: NodeStyles;
  intent?: string;
  children?: NodeInput[];
};

/**
 * **Unrolled to the depth limit rather than recursive.** A `z.lazy` schema
 * becomes a JSON Schema `$ref`, and several MCP clients cannot load a tool
 * whose schema has one (`lib/mcp/schema-compat.test.ts` refuses it). A subtree
 * can never be deeper than `TREE_LIMITS.maxDepth` anyway, so the fixed depth
 * loses nothing — undo can still put back the deepest node removed.
 */
function nodeInputAtDepth(depth: number): z.ZodType<NodeInput> {
  const fields = {
    id: z.string().regex(NODE_ID_PATTERN).optional(),
    type: z.string().min(1).max(40),
    props: z.record(z.string(), z.unknown()).optional(),
    styles: nodeStylesSchema.optional(),
    intent: z.string().max(TREE_LIMITS.maxIntentLength).optional(),
  };
  if (depth === 0) return z.object(fields).strict();
  return z
    .object({ ...fields, children: z.array(nodeInputAtDepth(depth - 1)).max(TREE_LIMITS.maxNodes).optional() })
    .strict();
}

export const nodeInputSchema: z.ZodType<NodeInput> = nodeInputAtDepth(TREE_LIMITS.maxDepth);

/**
 * A full node from input: defaults applied, ids assigned. A supplied id is
 * kept — that is how undo puts back exactly the node it removed — unless it
 * already exists in `taken`, in which case a fresh one is minted.
 */
export function buildNode(input: NodeInput, taken: Set<string>, id: IdGenerator = randomNodeId): PageNode {
  const def = getBlock(input.type);
  if (!def) throw new TreeError("INVALID", `Unknown block type "${input.type}".`);
  if (!def.insertable) throw new TreeError("INVALID", `A ${input.type} block cannot be added.`);

  let nodeId = input.id && !taken.has(input.id) ? input.id : id();
  while (taken.has(nodeId)) nodeId = id();
  taken.add(nodeId);

  const node: PageNode = {
    id: nodeId,
    type: input.type,
    props: { ...clone(def.defaults.props), ...(input.props ?? {}) },
  };
  // A new block starts with its defaults; a node coming back (it carries its id) keeps exactly its own.
  const styles = input.styles ?? (input.id === undefined ? def.defaults.styles : undefined);
  if (styles && Object.keys(styles).length) node.styles = clone(styles);
  if (input.intent) node.intent = input.intent;

  if (def.children !== "none") {
    const kids = input.children ?? defaultChildren(input.type);
    node.children = kids.map((c) => buildNode(c, taken, id));
  }
  return node;
}

/** Children a block starts with — two columns in a new columns block. */
function defaultChildren(type: string): NodeInput[] {
  if (type === "columns") return [{ type: "column" }, { type: "column" }];
  return [];
}

function allIds(root: PageNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: PageNode) => {
    ids.add(n.id);
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return ids;
}

// ---------- operations ----------

export type Placement = { parentId: string; index?: number; node: NodeInput };

/** Insert one or more nodes. Placements apply in order, so later indexes see earlier insertions. */
export function insertNodes(
  root: PageNode,
  placements: Placement[],
  id: IdGenerator = randomNodeId,
): { root: PageNode; inserted: { nodeId: string; parentId: string; index: number; type: string }[] } {
  const next = clone(root);
  const taken = allIds(next);
  const inserted: { nodeId: string; parentId: string; index: number; type: string }[] = [];

  for (const p of placements) {
    const parent = mustLocate(next, p.parentId).node;
    const node = buildNode(p.node, taken, id);
    if (!canContain(parent.type, node.type)) {
      throw new TreeError("INVALID", `A ${node.type} block cannot go inside a ${parent.type}.`, {
        parentId: p.parentId,
      });
    }
    const children = (parent.children ??= []);
    const index = p.index === undefined ? children.length : Math.max(0, Math.min(p.index, children.length));
    children.splice(index, 0, node);
    inserted.push({ nodeId: node.id, parentId: parent.id, index, type: node.type });
  }
  return { root: validateTree(next), inserted };
}

export type Removed = { parentId: string; index: number; node: PageNode };

/**
 * Remove nodes and everything inside them. A node inside another node being
 * removed is skipped — it goes with its ancestor. `removed` is ordered so that
 * re-inserting each at its recorded index, in order, restores the tree.
 */
export function removeNodes(root: PageNode, nodeIds: string[]): { root: PageNode; removed: Removed[] } {
  const next = clone(root);
  const targets = [...new Set(nodeIds)].map((nid) => mustLocate(next, nid));
  for (const t of targets) {
    if (!t.parent) throw new TreeError("INVALID", "The page root cannot be removed.");
  }
  const outermost = targets.filter((t) => !targets.some((o) => o !== t && isDescendant(o.node, t.node.id)));

  const removed: Removed[] = outermost
    .map((t) => ({ parentId: t.parent!.id, index: t.index, node: clone(t.node) }))
    // Ascending per parent: re-inserting lowest index first lands every node back in place.
    .sort((a, b) => (a.parentId === b.parentId ? a.index - b.index : a.parentId.localeCompare(b.parentId)));

  for (const t of outermost) {
    const parent = locate(next, t.parent!.id)!.node;
    parent.children = (parent.children ?? []).filter((c) => c.id !== t.node.id);
  }
  return { root: validateTree(next), removed };
}

export function moveNode(
  root: PageNode,
  nodeId: string,
  parentId: string,
  index?: number,
): { root: PageNode; from: { parentId: string; index: number }; to: { parentId: string; index: number } } {
  const next = clone(root);
  const hit = mustLocate(next, nodeId);
  if (!hit.parent) throw new TreeError("INVALID", "The page root cannot be moved.");
  if (nodeId === parentId || isDescendant(hit.node, parentId)) {
    throw new TreeError("INVALID", "A block cannot be moved inside itself.");
  }
  const target = mustLocate(next, parentId).node;
  if (!canContain(target.type, hit.node.type)) {
    throw new TreeError("INVALID", `A ${hit.node.type} block cannot go inside a ${target.type}.`);
  }

  const from = { parentId: hit.parent.id, index: hit.index };
  hit.parent.children = (hit.parent.children ?? []).filter((c) => c.id !== nodeId);
  const children = (target.children ??= []);
  const at = index === undefined ? children.length : Math.max(0, Math.min(index, children.length));
  children.splice(at, 0, hit.node);
  return { root: validateTree(next), from, to: { parentId: target.id, index: at } };
}

/** A copy of a node and its subtree, with fresh ids, placed right after the original. */
export function duplicateNode(
  root: PageNode,
  nodeId: string,
  id: IdGenerator = randomNodeId,
): { root: PageNode; newId: string; parentId: string; index: number } {
  const hit = mustLocate(root, nodeId);
  if (!hit.parent) throw new TreeError("INVALID", "The page root cannot be duplicated.");
  const strip = (n: PageNode): NodeInput => ({
    type: n.type,
    props: clone(n.props),
    styles: n.styles ? clone(n.styles) : undefined,
    intent: n.intent,
    children: n.children?.map(strip),
  });
  const { root: next, inserted } = insertNodes(
    root,
    [{ parentId: hit.parent.id, index: hit.index + 1, node: strip(hit.node) }],
    id,
  );
  return { root: next, newId: inserted[0].nodeId, parentId: hit.parent.id, index: hit.index + 1 };
}

export type FieldChange = { key: string; before: unknown; after: unknown };

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Merge props into a node (`null` in `unset` removes an optional prop) and validate against its block. */
export function setProps(
  root: PageNode,
  nodeId: string,
  patch: Record<string, unknown>,
  unset: string[] = [],
): { root: PageNode; changes: FieldChange[] } {
  const next = clone(root);
  const hit = mustLocate(next, nodeId);
  const before = clone(hit.node.props);
  const merged: Record<string, unknown> = { ...before, ...patch };
  for (const key of unset) delete merged[key];
  hit.node.props = merged;
  const validated = validateTree(next);
  const after = locate(validated, nodeId)!.node.props;

  const keys = new Set([...Object.keys(patch), ...unset]);
  const changes = [...keys]
    .filter((k) => !same(before[k], after[k]))
    .map((k) => ({ key: k, before: before[k] ?? null, after: after[k] ?? null }));
  return { root: validated, changes };
}

/** Set or clear (`null`) style tokens at one breakpoint. */
export function setStyles(
  root: PageNode,
  nodeId: string,
  breakpoint: Breakpoint,
  patch: Record<string, unknown>,
): { root: PageNode; changes: FieldChange[] } {
  const next = clone(root);
  const hit = mustLocate(next, nodeId);
  const styles: NodeStyles = clone(hit.node.styles ?? {});
  const current: Record<string, unknown> = { ...(styles[breakpoint] ?? {}) };
  const changes: FieldChange[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const before = current[key] ?? null;
    if (value === null) delete current[key];
    else current[key] = value;
    const after = current[key] ?? null;
    if (!same(before, after)) changes.push({ key, before, after });
  }
  // Validate this breakpoint's set before it is stored, so the error names the bad token.
  const parsed = styleSchema.safeParse(current);
  if (!parsed.success) throw new TreeError("INVALID", `Invalid styles: ${issuesOf(parsed.error)}`, { nodeId });

  if (Object.keys(current).length) styles[breakpoint] = current as StyleProps;
  else delete styles[breakpoint];
  if (Object.keys(styles).length) hit.node.styles = styles;
  else delete hit.node.styles;
  return { root: validateTree(next), changes };
}

export function setIntent(root: PageNode, nodeId: string, intent: string | null): { root: PageNode; before: string | null } {
  const next = clone(root);
  const hit = mustLocate(next, nodeId);
  const before = hit.node.intent ?? null;
  if (intent) hit.node.intent = intent;
  else delete hit.node.intent;
  return { root: validateTree(next), before };
}
