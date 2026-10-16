import type { DiffEntry } from "../db";

/**
 * The pure half of agent proposals: comparing diffs, counting what they touch,
 * and naming the tools that create them.
 */

/** A diff entry as a comparable string, independent of key order. */
function entryKey(d: DiffEntry): string {
  return JSON.stringify([d.entity, d.entityId, d.path, d.before ?? null, d.after ?? null]);
}

/**
 * Whether a fresh dry run still says what the stored proposal says.
 *
 * **This is what makes "approve" mean what the merchant read.** Between the
 * agent proposing and the merchant approving, someone may have edited the
 * product, sold the last unit, or approved another proposal touching the same
 * field. Executing anyway would apply a change the merchant never saw — the
 * `before` in the card would be fiction. So approval re-runs the dry run and
 * refuses as `stale` unless the two diffs are the same set of changes.
 *
 * Order-insensitive: an action may record its fields in a different order on a
 * second run, and that is not a different change.
 */
export function sameDiff(a: DiffEntry[], b: DiffEntry[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(entryKey).sort();
  const right = b.map(entryKey).sort();
  return left.every((key, i) => key === right[i]);
}

/** Distinct entities a diff touches — the "affects N items" on a proposal card. */
export function affectedCount(diff: DiffEntry[]): number {
  return new Set(diff.map((d) => `${d.entity}:${d.entityId}`)).size;
}

/**
 * Tool name for proposing an action: `catalog.updateProduct` →
 * `propose_catalog_updateProduct`.
 *
 * Dots become underscores because several model APIs refuse a dot in a tool
 * name — the same reason, and the same reversibility condition, as the MCP
 * server's tool names: no action id contains an underscore (asserted by the
 * MCP tests).
 */
export function proposeToolName(actionId: string): string {
  return `propose_${actionId.replace(/\./g, "_")}`;
}

/** Longest value rendered in full for the model; past this it gets a length. */
const MAX_VALUE_CHARS = 400;

function clip(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_VALUE_CHARS) {
    return `${value.slice(0, MAX_VALUE_CHARS)}… (${value.length} characters)`;
  }
  return value ?? null;
}

/**
 * The diff as the model sees it in a tool result — enough to describe the
 * proposal accurately, clipped so a 10,000-character description does not
 * cost 10,000 characters every time it is mentioned.
 */
export function diffForModel(diff: DiffEntry[]) {
  return diff.map((d) => ({
    entity: d.entity,
    id: d.entityId,
    field: d.path,
    before: clip(d.before),
    after: clip(d.after),
  }));
}
