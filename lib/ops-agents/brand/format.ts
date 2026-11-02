import type { DiffEntry } from "../../db";
import type { PageNode } from "../../builder/types";

/**
 * The pure half of the brand agent's live context (D51): how the current
 * draft, and what changed in it since the agent last spoke, are written into
 * a turn's instructions. No database here, so a test can hold it to account.
 */

/** Longest string prop shown whole in the outline; the full tree is `get_page`. */
const OUTLINE_VALUE_CHARS = 120;

/** Past this, the outline stops and says so — a 500-node page would otherwise fill the context. */
export const OUTLINE_MAX_CHARS = 24_000;

function clipValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > OUTLINE_VALUE_CHARS ? `${value.slice(0, OUTLINE_VALUE_CHARS)}…` : value;
  }
  if (Array.isArray(value)) return value.length > 6 ? [...value.slice(0, 6).map(clipValue), `…${value.length - 6} more`] : value.map(clipValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clipValue(v)]));
  }
  return value;
}

/**
 * One line per node, indented by depth: id, type, props, styles, intent.
 *
 * Ids are the point — every edit tool addresses a node by id, and an agent
 * that has to guess one edits the wrong block.
 */
export function outlineTree(root: PageNode, opts: { selectedId?: string | null; maxChars?: number } = {}): string {
  const max = opts.maxChars ?? OUTLINE_MAX_CHARS;
  const lines: string[] = [];
  let used = 0;
  let truncated = 0;

  const visit = (node: PageNode, depth: number) => {
    const parts = [`${"  ".repeat(depth)}- ${node.id} ${node.type}`];
    const props = node.props as Record<string, unknown>;
    if (props && Object.keys(props).length) parts.push(JSON.stringify(clipValue(props)));
    if (node.styles && Object.keys(node.styles).length) parts.push(`styles=${JSON.stringify(node.styles)}`);
    if (node.intent) parts.push(`intent=${JSON.stringify(node.intent)}`);
    if (opts.selectedId && node.id === opts.selectedId) parts.push("← SELECTED");
    const line = parts.join(" ");
    if (used + line.length > max) {
      truncated += 1;
    } else {
      lines.push(line);
      used += line.length + 1;
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(root, 0);

  if (truncated) lines.push(`… ${truncated} more node(s) not shown — call get_page for the full tree.`);
  return lines.join("\n");
}

/** A builder invocation as the context reads it from the audit table. */
export type ChangeRow = {
  actionId: string;
  actorType: string;
  actorId: string | null;
  diff: DiffEntry[];
  undoOf: string | null;
  occurredAt: Date;
};

/** Who did it, as the agent should be told — never an id it cannot use. */
export function changeActor(row: Pick<ChangeRow, "actorType" | "actorId">, viewerUserId: string, names: Map<string, string>): string {
  if (row.actorType === "user") {
    if (row.actorId === viewerUserId) return "the merchant (the person you are talking to)";
    const name = row.actorId ? names.get(row.actorId) : undefined;
    return name ? `another staff member (${name})` : "another staff member";
  }
  if (row.actorType === "token") return "an API token or MCP client";
  if (row.actorType === "agent") return "a brand-agent conversation";
  return "Markii";
}

function shortValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** The diff entries of one change, a few at a time. */
function diffSummary(diff: DiffEntry[], limit = 4): string {
  const shown = diff.slice(0, limit).map((d) => {
    const where = d.entity === "sitePage" ? `page #${d.entityId} ${d.path}` : d.path;
    return `${where}: ${shortValue(d.before)} → ${shortValue(d.after)}`;
  });
  if (diff.length > limit) shown.push(`…${diff.length - limit} more field(s)`);
  return shown.join("; ");
}

/** The change list, oldest first, capped. */
export function describeChanges(rows: ChangeRow[], viewerUserId: string, names: Map<string, string>, limit = 30): string {
  const lines = rows.slice(0, limit).map((r) => {
    const action = r.actionId.replace(/^builder\./, "");
    const undo = r.undoOf ? " (an undo)" : "";
    const diff = r.diff.length ? ` — ${diffSummary(r.diff)}` : "";
    return `- ${r.occurredAt.toISOString().slice(11, 16)} UTC, ${changeActor(r, viewerUserId, names)}: ${action}${undo}${diff}`;
  });
  if (rows.length > limit) lines.push(`- …and ${rows.length - limit} more change(s).`);
  return lines.join("\n");
}

/** Builder actions that are not edits to the design — never reported as changes. */
export const NOT_A_DESIGN_CHANGE = new Set(["builder.stopAgent", "builder.startDesign"]);

/**
 * When the previous turn of a conversation began — the `sentAt` the server
 * stamps on each user message — or null on the first turn.
 *
 * Nobody else can edit while a turn holds the lease, so "changed since your
 * last reply" is everything others did after this moment. A transcript from
 * before stamps existed yields null, which reports nothing rather than
 * inventing a window.
 */
export function previousTurnStart(history: { role: string; metadata?: unknown }[]): Date | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") continue;
    const sentAt = (m.metadata as { sentAt?: unknown } | undefined)?.sentAt;
    if (typeof sentAt !== "string") return null;
    const at = new Date(sentAt);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return null;
}
