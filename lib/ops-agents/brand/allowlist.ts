/**
 * The brand agent's write surface (D51), kept apart from the agent so a unit
 * test can hold it to account without loading the model plumbing.
 *
 * Unlike the Catalog agent's allowlist these **execute** — the owner chose
 * (2026-10-31) to have the agent edit the draft directly while the merchant
 * watches the preview, rather than raise a card per change. What keeps that
 * safe is the set itself: every entry is an `agentExecution: "draft"` action,
 * so nothing here changes what shoppers see. Publishing, discarding, restoring,
 * deleting pages and custom code are absent by construction, and `invokeAction`
 * would refuse them from an agent anyway.
 */
export const BRAND_DRAFT_ACTIONS = [
  "builder.addBlock",
  "builder.insertNodes",
  "builder.insertPreset",
  "builder.removeNodes",
  "builder.moveNode",
  "builder.duplicateNode",
  "builder.setProps",
  "builder.setStyles",
  "builder.setTheme",
  "builder.setThemeTokens",
  "builder.createPage",
  "builder.updatePage",
  // M4: templates, regions, data bindings and visibility — still draft-only.
  "builder.customizeTemplate",
  "builder.customizeRegion",
  "builder.setBinding",
  "builder.setVisibility",
] as const;
