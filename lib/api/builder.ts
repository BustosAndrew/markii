import type { describeBindings, ValueType } from "@/lib/builder/bindings";
import type { FieldSpec } from "@/lib/builder/blocks";
import type { CheckResult } from "@/lib/builder/checks";
import type { DesignTokens } from "@/lib/builder/tokens";
import type { Breakpoint, Condition, PageNode, PageSeo, RegionHandle, StyleProps, TemplateHandle } from "@/lib/builder/types";
import { invokeAction } from "./actions";
import { apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";

/**
 * The site builder (`docs/API.md` §19, D51).
 *
 * **Reads are REST; every write is a registry action** through
 * `POST /api/actions/builder.*` — the same actions the brand agent and MCP
 * clients call, so the editor has no privileged path of its own. Each write
 * answers with the new `revision`; reload the preview when it changes.
 *
 * Two refusals to handle by code, not by message:
 * - `409 AGENT_EDITING` — the brand agent holds the pen. Show "Stop the agent
 *   to edit" and keep the editor read-only until the lease is released.
 * - `409 CONFLICT` with `details.reason: "design_not_started"` — call
 *   `startDesign` first (the editor does this on open).
 */

export const BUILDER_API_LIVE = true;
const SECTION = "API §19";

export type { PageNode, PageSeo, Breakpoint, StyleProps, DesignTokens, CheckResult, FieldSpec, Condition, TemplateHandle, RegionHandle };
export type ThemeId = "studio" | "atlas" | "noir" | "bloom";

export type AgentLock = { active: boolean; sessionId: string | null; expiresAt: string | null };

export type DesignPage = {
  id: number;
  handle: string;
  title: string;
  /** Deleted in the draft; still live until the next publish. */
  deleted: boolean;
  published: boolean;
  /** `/` for home, `/pages/{handle}` otherwise. */
  path: string;
  updatedAt: string;
};

/**
 * A product/collection template or a global region (M4). `id` is null until
 * customised — the storefront uses its built-in layout meanwhile — and is a
 * `pageId` like any page's once it exists: every tree edit takes it.
 */
export type SharedDocument<H extends string = string> = {
  handle: H;
  title: string;
  id: number | null;
  customized: boolean;
  /** Reset in the draft: the built-in layout returns at the next publish. */
  deleted: boolean;
  published: boolean;
  /** Where to point the preview to see it; null when the store has nothing to show it with. */
  previewPath: string | null;
};

export type DesignSummary =
  | { siteId: number; started: false }
  | {
      siteId: number;
      started: true;
      themeId: ThemeId;
      tokens: DesignTokens;
      /** WCAG AA contrast warnings for the draft theme, ready to show. */
      contrast: string[];
      revision: number;
      publishedRevision: number;
      hasUnpublishedChanges: boolean;
      publishedVersion: number;
      publishedAt: string | null;
      agentLock: AgentLock;
      pages: DesignPage[];
      templates: SharedDocument<TemplateHandle>[];
      regions: SharedDocument<RegionHandle>[];
    };

export type PageDocument = {
  id: number;
  kind: "page" | "template" | "region";
  handle: string;
  title: string;
  seo: PageSeo;
  deleted: boolean;
  tree: PageNode;
  published: { handle: string | null; title: string | null; seo: PageSeo | null; tree: PageNode } | null;
  updatedAt: string;
};

export type BlockDescription = {
  type: string;
  label: string;
  category: "layout" | "content" | "commerce" | "media" | "navigation";
  description: string;
  usageHints: string[];
  children: "none" | "any" | string[];
  maxChildren: number | null;
  parents: string[] | null;
  defaults: { props: Record<string, unknown>; styles?: PageNode["styles"] };
  /** Generate the inspector from this — one field per entry. */
  editorPanel: FieldSpec[];
  semantics: { element: string; landmark?: string };
  /** M4: props that may be bound to data, and the value types each takes. Match against `BlockRegistry.data.bindings[].type`. */
  bindable: Record<string, ValueType[]>;
  /** M4: the block only works where this data exists — `product` means the product template. */
  requiresScope: "product" | "collection" | "item" | null;
  /** JSON Schema for the block's props. */
  props: Record<string, unknown>;
};

export type BlockRegistry = {
  blocks: BlockDescription[];
  presets: { id: string; label: string; description: string }[];
  tokens: { fonts: string[]; radius: string[]; maxWidth: string[] };
  /** M4: the binding paths, visibility conditions and repeater sources. */
  data: ReturnType<typeof describeBindings>;
};

export type DesignRevision = { started: boolean; revision: number; publishedRevision: number; agentLock: AgentLock };

export type DesignVersion = { version: number; note: string | null; publishedBy: string; createdAt: string };

// ---------- reads ----------

export const getBlockRegistry = (init?: RequestInit) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () => apiGet<BlockRegistry>("/api/builder/blocks", undefined, init));

export const getDesign = (site: string | number, init?: RequestInit) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () => apiGet<DesignSummary>(`/api/builder/sites/${site}`, undefined, init));

export const getDesignPage = (site: string | number, pageId: number, init?: RequestInit) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () =>
    apiGet<PageDocument>(`/api/builder/sites/${site}/pages/${pageId}`, undefined, init),
  );

/** Cheap enough to poll every couple of seconds while the editor is open. */
export const getDesignRevision = (site: string | number, init?: RequestInit) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () => apiGet<DesignRevision>(`/api/builder/sites/${site}/revision`, undefined, init));

export const getDesignChecks = (site: string | number, init?: RequestInit) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () =>
    apiGet<{ results: CheckResult[]; blocking: number }>(`/api/builder/sites/${site}/checks`, undefined, init),
  );

export const listDesignVersions = (site: string | number, init?: RequestInit) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () => apiGet<{ items: DesignVersion[] }>(`/api/builder/sites/${site}/versions`, undefined, init));

/**
 * A two-hour live-preview URL for the editor's iframe (M2). Not a registry
 * action — its result is a credential, which the audit log must not hold.
 * Re-mint before `expiresAt`; an expired preview answers 404.
 */
export const createPreviewSession = (site: string | number) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () =>
    apiPost<{ url: string; expiresAt: string }>(`/api/builder/sites/${site}/preview-session`, {}),
  );

// ---------- writes (registry actions) ----------

type Revisioned = { revision: number | null };

export const startDesign = (siteId: number) => invokeAction<{ siteId: number; started: boolean }>("builder.startDesign", { siteId });

export const addBlock = (input: { siteId: number; pageId: number; parentId: string; index?: number; type: string; props?: Record<string, unknown>; intent?: string }) =>
  invokeAction<{ nodeId: string } & Revisioned>("builder.addBlock", input);

export const insertPreset = (input: { siteId: number; pageId: number; parentId: string; index?: number; preset: string }) =>
  invokeAction<{ nodeId: string } & Revisioned>("builder.insertPreset", input);

export const removeNodes = (input: { siteId: number; pageId: number; nodeIds: string[] }) =>
  invokeAction<Revisioned>("builder.removeNodes", input);

export const moveNode = (input: { siteId: number; pageId: number; nodeId: string; parentId: string; index?: number }) =>
  invokeAction<Revisioned>("builder.moveNode", input);

export const duplicateNode = (input: { siteId: number; pageId: number; nodeId: string }) =>
  invokeAction<{ nodeId: string } & Revisioned>("builder.duplicateNode", input);

export const setNodeProps = (input: { siteId: number; pageId: number; nodeId: string; props: Record<string, unknown>; unset?: string[]; intent?: string | null }) =>
  invokeAction<{ changed: string[] } & Revisioned>("builder.setProps", input);

/** `null` clears a token at that breakpoint. */
export const setNodeStyles = (input: { siteId: number; pageId: number; nodeId: string; breakpoint: Breakpoint; styles: { [K in keyof StyleProps]?: StyleProps[K] | null } }) =>
  invokeAction<{ changed: string[] } & Revisioned>("builder.setStyles", input);

export const setDesignTheme = (siteId: number, themeId: ThemeId) => invokeAction<Revisioned>("builder.setTheme", { siteId, themeId });

/** `null` returns a token to the theme's own value. The result carries contrast warnings. */
export const setDesignTokens = (siteId: number, tokens: { [K in keyof DesignTokens]?: DesignTokens[K] | null }) =>
  invokeAction<{ tokens: DesignTokens; contrast: CheckResult[] } & Revisioned>("builder.setThemeTokens", { siteId, tokens });

export const createDesignPage = (siteId: number, handle: string, title: string) =>
  invokeAction<{ pageId: number } & Revisioned>("builder.createPage", { siteId, handle, title });

export const updateDesignPage = (input: { siteId: number; pageId: number; title?: string; handle?: string; seo?: PageSeo }) =>
  invokeAction<Revisioned>("builder.updatePage", input);

export const deleteDesignPage = (siteId: number, pageId: number) => invokeAction<Revisioned>("builder.deletePage", { siteId, pageId });

export const restoreDesignPage = (siteId: number, pageId: number) => invokeAction<Revisioned>("builder.restorePage", { siteId, pageId });

/**
 * Start a template or region from the current layout (M4). Idempotent:
 * `created: false` with the existing `pageId` when it already exists. Reset
 * one with `deleteDesignPage` — it falls back to the built-in layout on publish.
 */
export const customizeTemplate = (siteId: number, template: TemplateHandle) =>
  invokeAction<{ pageId: number; created: boolean } & Revisioned>("builder.customizeTemplate", { siteId, template });

export const customizeRegion = (siteId: number, region: RegionHandle) =>
  invokeAction<{ pageId: number; created: boolean } & Revisioned>("builder.customizeRegion", { siteId, region });

/** Bind props to data paths (`null` unbinds). A path must be one of `BlockRegistry.data.bindings`. */
export const setNodeBindings = (input: { siteId: number; pageId: number; nodeId: string; bindings: Record<string, string | null> }) =>
  invokeAction<{ changed: string[] } & Revisioned>("builder.setBinding", input);

/** Show a block only when `when` holds; `null` shows it always. */
export const setNodeVisibility = (input: { siteId: number; pageId: number; nodeId: string; when: Condition | null }) =>
  invokeAction<Revisioned>("builder.setVisibility", input);

/**
 * Publish the whole draft. A blocked publish is `409 CONFLICT` with
 * `details.reason: "checks_failed"` and `details.checks` — show the errors.
 */
export const publishDesign = (siteId: number, note?: string) =>
  invokeAction<{ version: number; pages: number; removedPages: number; warnings: CheckResult[] }>("builder.publish", { siteId, note });

/**
 * Take the pen back from the brand agent (D51): frees its edit lease, so its
 * further edits are refused and the editor is writable at once. Call it on
 * Stop **as well as** aborting the chat stream — an aborted fetch may never
 * reach the server. `stopped: false` when no agent was editing.
 */
export const stopBrandAgent = (siteId: number) =>
  invokeAction<{ stopped: boolean; sessionId: string | null }>("builder.stopAgent", { siteId });

/** Irreversible — confirm first. */
export const discardDesignDraft = (siteId: number) => invokeAction<Revisioned>("builder.discardDraft", { siteId });

/** Copies a version into the draft (not live until published). Irreversible — confirm first. */
export const restoreDesignVersion = (siteId: number, version: number) =>
  invokeAction<{ version: number } & Revisioned>("builder.restoreVersion", { siteId, version });
