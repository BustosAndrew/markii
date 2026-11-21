import { countNodes, emptyRoot, insertNodes, nodeToInput, type NodeInput } from "@markii/renderer/tree";

/** How many saved blocks one site may keep. A library, not a second page store. */
export const SAVED_BLOCKS_PER_SITE = 100;

/**
 * A saved block as it is stored (D51 M7): built into a scratch page so it goes
 * through exactly the checks any insert does — known block types, nesting,
 * limits, custom HTML rebuilt from the allowlist — then stripped of its ids.
 * Throws `TreeError` for anything an insert would refuse.
 */
export function normalizeSavedBlock(input: NodeInput): { node: NodeInput; nodeCount: number } {
  const scratch = emptyRoot();
  const { root } = insertNodes(scratch, [{ parentId: scratch.id, node: input }]);
  const built = root.children![0];
  return { node: nodeToInput(built), nodeCount: countNodes(built) };
}
