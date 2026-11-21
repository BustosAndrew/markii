import { emptyRoot, insertNodes, type NodeInput } from "@markii/renderer/tree";
import type { PageNode } from "@markii/renderer/types";

/**
 * The pages a store has no document for — a category, the collections index,
 * search results — drawn as small node trees, so they render through the same
 * renderer and theme as everything else rather than as hand-written markup.
 */
export function listingTree(nodes: NodeInput[]): PageNode {
  const root = emptyRoot();
  return insertNodes(root, [{ parentId: root.id, node: { type: "section", children: nodes } }]).root;
}
