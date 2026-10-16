/**
 * The Catalog agent's write surface (D47), kept apart from the agent itself so
 * a unit test can hold it to account without loading the model plumbing.
 */

/**
 * What the Catalog agent may propose. The allowlist is the agent's whole write surface —
 * billing, payouts, staff, customers, orders, deletion and publishing a store
 * are absent by construction, which is `docs/AGENT-OPS.md` §1's "never in
 * scope" list enforced by omission rather than by an instruction the model
 * could be talked out of.
 */
export const CATALOG_PROPOSABLE_ACTIONS = [
  "catalog.updateProduct",
  "catalog.updateVariant",
  "catalog.updateCollection",
  "catalog.setCollectionProducts",
  "inventory.adjust",
] as const;
