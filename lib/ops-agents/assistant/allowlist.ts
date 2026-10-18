/**
 * The assistant's write surface (§27): **empty**, and a unit test holds it so.
 *
 * Kept beside the Catalog agent's allowlist and fed through the same
 * `proposeTools`, so the assistant's tools are built exactly as a proposing
 * agent's are — it simply has nothing to propose. Adding an action here is a
 * product decision with its own review, not a convenience.
 *
 * **Creates in particular cannot go here yet.** The setup work the assistant
 * points at is mostly creating rows — a shipping zone, a rate, a location —
 * and a proposed create can never be approved: its dry run advances a
 * Postgres sequence that the rollback does not return, so approval's second
 * dry run records a different `entityId` and `sameDiff` refuses it as stale
 * every time. Proposals need a way to say "a new row" first.
 */
export const ASSISTANT_PROPOSABLE_ACTIONS: readonly string[] = [];
