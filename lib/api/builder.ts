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
      /** M6: the draft's custom CSS ("" when none). Saved with `setCustomCss` — by a person only. */
      customCss: string;
      /**
       * M6: the draft's custom scripts (head code), stored cleaned — show this,
       * not what was typed. Saved with `setHeadCode` (`cms.scripts`, a person,
       * step-up). Never run in the preview.
       */
      headHtml: string;
      /** The draft's custom scripts differ from what is live. */
      headHtmlChanged: boolean;
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
  category: "layout" | "content" | "commerce" | "media" | "navigation" | "advanced";
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

/**
 * A block and its subtree as input for a new copy — no ids, so inserting mints
 * fresh ones (M7: copy/paste, saved blocks). Mirrors the server's `NodeInput`.
 */
export type NodeInput = {
  type: string;
  props?: Record<string, unknown>;
  styles?: PageNode["styles"];
  intent?: string;
  bindings?: Record<string, string>;
  visibleWhen?: Condition;
  customClass?: string;
  children?: NodeInput[];
};

/** A saved block (M7). `node` goes straight into `insertNodes`. */
export type SavedBlock = {
  id: number;
  name: string;
  /** The outer block's type — what the library shows and what decides where it can go. */
  type: string;
  nodeCount: number;
  node: NodeInput;
  createdBy: string;
  createdAt: string;
};

export const listSavedBlocks = (site: string | number, init?: RequestInit) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () => apiGet<{ items: SavedBlock[] }>(`/api/builder/sites/${site}/saved-blocks`, undefined, init));

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

/**
 * Insert whole subtrees in one undoable step — paste, bulk duplicate and saved
 * blocks (M7). Placements apply in order; later indexes see earlier inserts.
 * Custom HTML in a pasted block is re-cleaned, and refused from a token.
 */
export const insertNodes = (input: { siteId: number; pageId: number; placements: { parentId: string; index?: number; node: NodeInput }[] }) =>
  invokeAction<{ inserted: { nodeId: string; parentId: string; index: number; type: string }[] } & Revisioned>("builder.insertNodes", input);

/** Several moves as one undo step (M7 bulk move). Each sees the page as the previous left it. */
export const moveNodes = (input: { siteId: number; pageId: number; moves: { nodeId: string; parentId: string; index?: number }[] }) =>
  invokeAction<Revisioned>("builder.moveNodes", input);

/** Save a block to the site's library (M7). `409 CONFLICT` with `details.reason` `name_taken` or `limit`. */
export const saveBlock = (input: { siteId: number; name: string; node: NodeInput }) =>
  invokeAction<{ savedBlockId: number; name: string; nodeCount: number }>("builder.saveBlock", input);

export const deleteSavedBlock = (siteId: number, savedBlockId: number) =>
  invokeAction<{ savedBlockId: number }>("builder.deleteSavedBlock", { siteId, savedBlockId });

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

/**
 * Replace the site's custom CSS (M6). `high`: a signed-in person only — agents
 * and API tokens get `403 HUMAN_APPROVAL_REQUIRED`. A refusal on content is
 * `400 VALIDATION_ERROR` with `details.problems` (no "<", no @import, https-only
 * `url()`); show them. Not applied on the cart or account pages.
 */
export const setCustomCss = (siteId: number, css: string) => invokeAction<Revisioned>("builder.setCustomCss", { siteId, css });

/**
 * Replace the storefront's custom scripts (M6 head code — analytics and pixels).
 * `cms.scripts` + `high` + step-up: a signed-in person with a fresh second
 * factor (the client's step-up modal handles `403 MFA_REQUIRED` and retries);
 * agents and API tokens get `403 HUMAN_APPROVAL_REQUIRED`. The code is rebuilt
 * on save: `headHtml` is what was stored and `removed` names what was dropped
 * (an iframe, `<meta http-equiv>`, a non-https src…) — show both. `400
 * VALIDATION_ERROR` with `details.problems` when nothing usable is left or it
 * is over 20,000 characters.
 */
export const setHeadCode = (siteId: number, html: string) =>
  invokeAction<{ headHtml: string; removed: string[] } & Revisioned>("builder.setHeadCode", { siteId, html });

/** A block's custom classes (M6); `null` clears. `mk-` / `sf-` names are refused. */
export const setNodeCustomClass = (input: { siteId: number; pageId: number; nodeId: string; customClass: string | null }) =>
  invokeAction<{ customClass: string | null } & Revisioned>("builder.setCustomClass", input);

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

// ---------- moving a design between stores (D53) ----------

/** Where one image reference sits, as the reports below name it — e.g. `page "home" › image n_…`. */
export type ImageRef = { url: string; place: "block" | "seo" | "html" | "css"; where: string };

/** What happened to a package's images. Show `external` and `unreadable` as warnings, never as errors. */
export type ImageReport = {
  /** Images carried inside the file (export) or stored in this org (import). */
  bundled: number;
  bytes: number;
  /** Hosted outside the store's own uploads, so left as links — they break if that host removes them. */
  external: ImageRef[];
  /** The store's own uploads that could not be read; left as links. */
  unreadable: ImageRef[];
};

export type DesignApplyResult = {
  revision: number;
  documents: number;
  removedDocuments: number;
  savedBlocks: { added: string[]; skipped: { name: string; reason: "name_taken" | "limit" }[] };
  /** Custom scripts never travel: the store keeps its own. */
  headCode: "kept";
};

/**
 * Copy another store's design (same org) into this store's **draft** — not live
 * until published. `high`: a signed-in person only. Refusals to handle by code:
 * - `409 CONFLICT`, `details.reason: "unpublished_changes"` — the draft has work
 *   that this would destroy. Confirm, then call again with `discardUnpublished: true`.
 * - `409`, `reason: "nothing_published"` — the source has no live design; offer `source: "draft"`.
 * - `409`, `reason: "no_design"` — the source store was never designed.
 *
 * `sourceHasHeadCode: true` means the source has custom scripts that were not
 * copied; offer to copy them with `setHeadCode` (it asks for a fresh second factor).
 */
export const copyDesign = (input: { siteId: number; fromSiteId: number; source?: "published" | "draft"; discardUnpublished?: boolean }) =>
  invokeAction<DesignApplyResult & { fromSiteId: number; sourceHasHeadCode: boolean }>("builder.copyDesign", input);

export type ThemeExport = {
  /** A five-minute download link to the `.json` file. Open it; do not store it. */
  url: string;
  expiresAt: string;
  source: "draft" | "published";
  documents: number;
  savedBlocks: number;
  images: ImageReport;
  /** The store has custom scripts, which theme files never carry. Say so. */
  headCodeLeftOut: boolean;
};

/**
 * Export the design as a theme package file with the store's own images inside
 * it (`cms.read`). `409 reason: "nothing_published"` for `source: "published"`
 * on a store with nothing live; `409 reason: "package_too_large"` past 100
 * images / 5 MB each / 25 MB total.
 */
export const exportTheme = (site: string | number, source: "draft" | "published" = "draft") =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () => apiPost<ThemeExport>(`/api/builder/sites/${site}/theme-export`, { source }));

/**
 * Import a theme package file, in three steps — the file goes **straight to
 * storage**, because a theme with images is past the 4.5 MB a request may carry:
 *
 * 1. `createThemeUpload(site)` → `{ uploadId, uploadUrl, method, headers }`.
 * 2. `fetch(uploadUrl, { method, headers, body: file })` from the browser.
 * 3. `importThemeUpload(site, uploadId)` — with `dryRun: true` first to show
 *    what it will do, then for real. Same refusals as `copyDesign`
 *    (`unpublished_changes`), plus `400` for a file that is not a package or is
 *    damaged, and `404 reason: "no_upload"` for an unknown or someone else's upload.
 *
 * Each upload gets a new `uploadId`; never reuse one for a different file.
 */
export const createThemeUpload = (site: string | number) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () =>
    apiPost<{ uploadId: string; uploadUrl: string; method: "PUT"; headers: Record<string, string> }>(
      `/api/builder/sites/${site}/theme-import/upload-url`,
      {},
    ),
  );

export const importThemeUpload = (site: string | number, uploadId: string, opts: { discardUnpublished?: boolean; dryRun?: boolean } = {}) =>
  callWhenLive(BUILDER_API_LIVE, SECTION, () =>
    apiPost<{ invocationId: string; ok: boolean; dryRun: boolean; result?: DesignApplyResult; images: ImageReport }>(
      `/api/builder/sites/${site}/theme-import${opts.dryRun ? "?dryRun=1" : ""}`,
      { uploadId, discardUnpublished: opts.discardUnpublished ?? false },
    ),
  );
