import type { ActionInverse, DiffEntry, RecordedInvocation } from "./types";

/**
 * Shared shapes for `inverse()` (`docs/API.md` §22).
 *
 * Most undoable actions are the same shape — patch one row by id, record one
 * diff entry per changed field — so their inverse is the same action replayed
 * with the `before` values. Writing that once means the reconstruction cannot
 * drift between twelve copies of it.
 */

/** The recorded `before` for each path, for a diff about a single entity. */
export function beforeByPath(diff: DiffEntry[]): Map<string, unknown> {
  return new Map(diff.map((d) => [d.path, d.before]));
}

/** Ids are numeric in every commerce table; the diff stores them as text. */
function entityIdValue(raw: string): string | number {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

type PatchInverseOptions = {
  actionId: string;
  /** The input field naming the row — `variantId`, `collectionId`, `siteId`. */
  idField: string;
  /**
   * Diff paths whose name is not an input field, mapped back to input.
   *
   * `catalog.updateCollection` takes `published: boolean` but records the
   * `publishedAt` column it actually wrote. Without a mapping the reconstructed
   * input carries a key the action's schema does not declare, zod strips it,
   * and undo silently restores everything **except** the published state — the
   * one field the merchant was most likely undoing.
   */
  map?: Record<string, (before: unknown) => Record<string, unknown> | null>;
  /** Paths recorded for the reader that undo must not try to write back. */
  ignore?: string[];
  /**
   * Fields the action requires on every call, even unchanged ones. Taken from
   * the original input, where an unchanged field's value is by definition the
   * value it still has.
   */
  carryFromInput?: string[];
  conflictCheck?: "strict" | "none";
};

/**
 * The inverse of "patch these fields": the same action, the same row, the
 * values that were there before.
 */
export function patchInverse(options: PatchInverseOptions) {
  const { actionId, idField, map = {}, ignore = [], carryFromInput = [] } = options;

  return (recorded: RecordedInvocation): ActionInverse | null => {
    const entries = recorded.diff.filter((d) => !ignore.includes(d.path));
    if (entries.length === 0) return null;

    // One row per invocation is the assumption this helper encodes. A bulk
    // action needs its own inverse, not a silently wrong one from here.
    const ids = new Set(entries.map((d) => d.entityId));
    if (ids.size !== 1) return null;

    const input: Record<string, unknown> = {
      [idField]: entityIdValue([...ids][0]),
    };

    for (const entry of entries) {
      const mapper = map[entry.path];
      if (mapper) {
        const mapped = mapper(entry.before);
        // The mapper is where "this value cannot be expressed as input" lives.
        if (mapped === null) return null;
        Object.assign(input, mapped);
        continue;
      }
      input[entry.path] = entry.before;
    }

    const original = (recorded.input ?? {}) as Record<string, unknown>;
    for (const field of carryFromInput) {
      if (!(field in input) && original[field] !== undefined) input[field] = original[field];
    }

    return {
      actionId,
      input,
      ...(options.conflictCheck ? { conflictCheck: options.conflictCheck } : {}),
    };
  };
}
