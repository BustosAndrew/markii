import type { FieldSpec } from "@/lib/builder/blocks";
import type { CheckResult } from "@/lib/builder/checks";
import type { DesignTokens } from "@/lib/builder/tokens";
import type { Breakpoint, PageNode, PageSeo, StyleProps } from "@/lib/builder/types";
import { invokeAction } from "./actions";
import { apiGet } from "./client";
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

export type { PageNode, PageSeo, Breakpoint, StyleProps, DesignTokens, CheckResult, FieldSpec };
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
  category: "layout" | "content" | "commerce" | "media";
  description: string;
  usageHints: string[];
  children: "none" | "any" | string[];
  maxChildren: number | null;
  parents: string[] | null;
  defaults: { props: Record<string, unknown>; styles?: PageNode["styles"] };
  /** Generate the inspector from this — one field per entry. */
  editorPanel: FieldSpec[];
  semantics: { element: string; landmark?: string };
  /** JSON Schema for the block's props. */
  props: Record<string, unknown>;
};

export type BlockRegistry = {
  blocks: BlockDescription[];
  presets: { id: string; label: string; description: string }[];
  tokens: { fonts: string[]; radius: string[]; maxWidth: string[] };
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
 * Publish the whole draft. A blocked publish is `409 CONFLICT` with
 * `details.reason: "checks_failed"` and `details.checks` — show the errors.
 */
export const publishDesign = (siteId: number, note?: string) =>
  invokeAction<{ version: number; pages: number; removedPages: number; warnings: CheckResult[] }>("builder.publish", { siteId, note });

/** Irreversible — confirm first. */
export const discardDesignDraft = (siteId: number) => invokeAction<Revisioned>("builder.discardDraft", { siteId });

/** Copies a version into the draft (not live until published). Irreversible — confirm first. */
export const restoreDesignVersion = (siteId: number, version: number) =>
  invokeAction<{ version: number } & Revisioned>("builder.restoreVersion", { siteId, version });
