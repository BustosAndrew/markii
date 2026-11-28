/**
 * What changed between two states of a site's design (`docs/BUILDER.md` §12:
 * "version history offers restore and diff"). Pure — it compares two
 * snapshots and reads nothing, so the route, the editor and a test all get
 * the same answer.
 *
 * A snapshot is the shape `builder.publish` stores in `site_design_versions`,
 * and the draft and the live design are read into that same shape, so any
 * two of them compare. Node ids survive publish and restore unchanged, which
 * is what lets a node be followed across versions rather than guessed at by
 * position.
 *
 * Unchanged documents and nodes are left out: the answer is the change, not
 * two copies of the site.
 */
import { getBlock } from "@markii/renderer/blocks";
import type { DesignTokens } from "@markii/renderer/tokens";
import type { PageNode, PageSeo } from "@markii/renderer/types";

export type DesignSnapshot = {
  themeId: string;
  tokens: DesignTokens;
  customCss?: string;
  headHtml?: string;
  /** `requiresTierId`: absent in snapshots from before migration 0054, which is public. */
  documents: { id: number; kind: string; handle: string; title: string; seo: PageSeo; tree: PageNode; requiresTierId?: number | null }[];
};

/** Long values are cut here — a diff names a change, it does not reprint a page of copy. */
export const DIFF_VALUE_MAX = 160;

export type ValueChange = { field: string; before: unknown; after: unknown };

export type NodeRef = { id: string; type: string; label: string };

export type NodeChange = NodeRef & {
  /** `props.heading`, `styles.md`, `moved`, `bindings`, `visibleWhen`, `customClass`, `intent`, `type`. */
  changes: ValueChange[];
};

export type DocumentDiff = {
  id: number;
  kind: string;
  handle: string;
  title: string;
  change: "added" | "removed" | "changed";
  /** `title`, `handle`, `requiresTierId`, `seo.title`, `seo.description`, `seo.noindex`, `seo.ogImage`. */
  fields: ValueChange[];
  nodes: { added: NodeRef[]; removed: NodeRef[]; changed: NodeChange[] };
};

export type DesignDiff = {
  identical: boolean;
  theme: { before: string; after: string } | null;
  tokens: ValueChange[];
  /** Lengths only — theme CSS is shown in full on the design itself. */
  customCss: { before: number; after: number } | null;
  /** Whether the storefront's custom scripts differ; their text is not repeated here. */
  headCode: { changed: boolean };
  documents: DocumentDiff[];
  summary: {
    documentsAdded: number;
    documentsRemoved: number;
    documentsChanged: number;
    nodesAdded: number;
    nodesRemoved: number;
    nodesChanged: number;
  };
};

function same(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** Key order must not make two equal objects differ — jsonb does not keep it. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  ) ?? "undefined";
}

/** A value fit to show: scalars as they are, long strings cut, objects as compact JSON, cut. */
export function shown(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "string") return value.length > DIFF_VALUE_MAX ? `${value.slice(0, DIFF_VALUE_MAX)}…` : value;
  if (value === null || typeof value !== "object") return value;
  const json = stableJson(value);
  return json.length > DIFF_VALUE_MAX ? `${json.slice(0, DIFF_VALUE_MAX)}…` : JSON.parse(json);
}

function change(field: string, before: unknown, after: unknown): ValueChange {
  return { field, before: shown(before), after: shown(after) };
}

function keyedChanges(prefix: string, before: Record<string, unknown> = {}, after: Record<string, unknown> = {}): ValueChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => !same(before[k], after[k])).map((k) => change(`${prefix}${k}`, before[k], after[k]));
}

type Placed = { node: PageNode; parentId: string | null; index: number };

function index(tree: PageNode): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const walk = (node: PageNode, parentId: string | null, i: number) => {
    out.set(node.id, { node, parentId, index: i });
    (node.children ?? []).forEach((child, at) => walk(child, node.id, at));
  };
  walk(tree, null, 0);
  return out;
}

function ref(node: PageNode): NodeRef {
  return { id: node.id, type: node.type, label: getBlock(node.type)?.label ?? node.type };
}

function nodeChanges(before: Placed, after: Placed): ValueChange[] {
  const a = before.node;
  const b = after.node;
  const out: ValueChange[] = [];
  if (a.type !== b.type) out.push(change("type", a.type, b.type));
  out.push(...keyedChanges("props.", a.props, b.props));
  out.push(...keyedChanges("styles.", a.styles as Record<string, unknown>, b.styles as Record<string, unknown>));
  if (!same(a.bindings ?? {}, b.bindings ?? {})) out.push(change("bindings", a.bindings ?? null, b.bindings ?? null));
  if (!same(a.visibleWhen ?? null, b.visibleWhen ?? null)) out.push(change("visibleWhen", a.visibleWhen ?? null, b.visibleWhen ?? null));
  if ((a.customClass ?? "") !== (b.customClass ?? "")) out.push(change("customClass", a.customClass ?? "", b.customClass ?? ""));
  if ((a.intent ?? "") !== (b.intent ?? "")) out.push(change("intent", a.intent ?? "", b.intent ?? ""));
  // A node is moved when its parent changed, or its place among siblings did
  // for a reason other than a sibling before it arriving or leaving — which
  // the index alone cannot tell, so only a parent change or a reorder of the
  // surviving siblings counts. Comparing raw indexes would report every block
  // below an insertion as moved.
  if (before.parentId !== after.parentId) out.push(change("moved", before.parentId, after.parentId));
  return out;
}

/** Siblings present on both sides whose relative order differs: those are the reordered ones. */
function reordered(beforeTree: Map<string, Placed>, afterTree: Map<string, Placed>): Set<string> {
  const out = new Set<string>();
  const childrenOf = (tree: Map<string, Placed>, parentId: string) =>
    [...tree.values()].filter((p) => p.parentId === parentId).sort((x, y) => x.index - y.index).map((p) => p.node.id);
  for (const [id] of afterTree) {
    if (!beforeTree.has(id)) continue;
    const kept = (ids: string[], other: Map<string, Placed>) => ids.filter((c) => other.get(c)?.parentId === id);
    const was = kept(childrenOf(beforeTree, id), afterTree);
    const now = kept(childrenOf(afterTree, id), beforeTree);
    if (same(was, now)) continue;
    // The fewest nodes that explain the new order: those off the longest common run.
    const stay = longestCommonSubsequence(was, now);
    for (const c of now) if (!stay.has(c)) out.add(c);
  }
  return out;
}

function longestCommonSubsequence(a: string[], b: string[]): Set<string> {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.add(a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return out;
}

function diffTrees(before: PageNode, after: PageNode): DocumentDiff["nodes"] {
  const a = index(before);
  const b = index(after);
  const moved = reordered(a, b);
  const added: NodeRef[] = [];
  const removed: NodeRef[] = [];
  const changed: NodeChange[] = [];
  for (const [id, placed] of b) {
    const was = a.get(id);
    if (!was) {
      added.push(ref(placed.node));
      continue;
    }
    const changes = nodeChanges(was, placed);
    if (moved.has(id) && !changes.some((c) => c.field === "moved")) changes.push(change("moved", was.index, placed.index));
    if (changes.length > 0) changed.push({ ...ref(placed.node), changes });
  }
  for (const [id, placed] of a) if (!b.has(id)) removed.push(ref(placed.node));
  return { added, removed, changed };
}

function documentFields(a: DesignSnapshot["documents"][number], b: DesignSnapshot["documents"][number]): ValueChange[] {
  const out: ValueChange[] = [];
  if (a.title !== b.title) out.push(change("title", a.title, b.title));
  if (a.handle !== b.handle) out.push(change("handle", a.handle, b.handle));
  // Who may read the page (§18.9) — the change a publish most needs to show.
  if ((a.requiresTierId ?? null) !== (b.requiresTierId ?? null)) out.push(change("requiresTierId", a.requiresTierId ?? null, b.requiresTierId ?? null));
  out.push(...keyedChanges("seo.", a.seo as Record<string, unknown>, b.seo as Record<string, unknown>));
  return out;
}

/** Every block in a document added or removed whole — the root is the page itself, not a block. */
function allNodes(tree: PageNode): NodeRef[] {
  return [...index(tree).values()].filter((p) => p.parentId !== null).map((p) => ref(p.node));
}

export function diffDesigns(from: DesignSnapshot, to: DesignSnapshot): DesignDiff {
  const theme = from.themeId !== to.themeId ? { before: from.themeId, after: to.themeId } : null;
  const tokens = keyedChanges("", from.tokens as Record<string, unknown>, to.tokens as Record<string, unknown>);
  const cssBefore = from.customCss ?? "";
  const cssAfter = to.customCss ?? "";
  const customCss = cssBefore !== cssAfter ? { before: cssBefore.length, after: cssAfter.length } : null;
  const headCode = { changed: (from.headHtml ?? "") !== (to.headHtml ?? "") };

  const fromDocs = new Map(from.documents.map((d) => [d.id, d]));
  const toDocs = new Map(to.documents.map((d) => [d.id, d]));
  const documents: DocumentDiff[] = [];
  for (const doc of to.documents) {
    const was = fromDocs.get(doc.id);
    const head = { id: doc.id, kind: doc.kind, handle: doc.handle, title: doc.title };
    if (!was) {
      documents.push({ ...head, change: "added", fields: [], nodes: { added: allNodes(doc.tree), removed: [], changed: [] } });
      continue;
    }
    const fields = documentFields(was, doc);
    const nodes = diffTrees(was.tree, doc.tree);
    if (fields.length + nodes.added.length + nodes.removed.length + nodes.changed.length > 0) {
      documents.push({ ...head, change: "changed", fields, nodes });
    }
  }
  for (const doc of from.documents) {
    if (toDocs.has(doc.id)) continue;
    documents.push({
      id: doc.id,
      kind: doc.kind,
      handle: doc.handle,
      title: doc.title,
      change: "removed",
      fields: [],
      nodes: { added: [], removed: allNodes(doc.tree), changed: [] },
    });
  }

  const count = (pick: (d: DocumentDiff) => number) => documents.reduce((n, d) => n + pick(d), 0);
  const summary = {
    documentsAdded: documents.filter((d) => d.change === "added").length,
    documentsRemoved: documents.filter((d) => d.change === "removed").length,
    documentsChanged: documents.filter((d) => d.change === "changed").length,
    nodesAdded: count((d) => d.nodes.added.length),
    nodesRemoved: count((d) => d.nodes.removed.length),
    nodesChanged: count((d) => d.nodes.changed.length),
  };
  const identical = !theme && tokens.length === 0 && !customCss && !headCode.changed && documents.length === 0;
  return { identical, theme, tokens, customCss, headCode, documents, summary };
}
