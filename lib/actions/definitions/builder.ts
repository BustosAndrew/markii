import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, conflict, notFound } from "../../api";
import { blockingErrors, checkPage, checkTheme, type CheckResult } from "../../builder/checks";
import { PRESETS, blankPageTree, defaultHomeTree } from "../../builder/presets";
import {
  bumpRevision,
  catalogFacts,
  loadPage,
  lockDesign,
  ownedSite,
  saveTree,
} from "../../builder/store";
import { applyTokenPatch, designTokensPatchSchema, resolveTheme, type DesignTokens } from "../../builder/tokens";
import {
  TreeError,
  duplicateNode,
  insertNodes,
  moveNode,
  nodeInputSchema,
  removeNodes,
  setIntent,
  setProps,
  setStyles,
  type Removed,
} from "../../builder/tree";
import { styleSchema } from "../../builder/styles";
import { BREAKPOINTS, HOME_HANDLE, type PageNode, type PageSeo } from "../../builder/types";
import { siteDesignVersions, siteDesigns, siteDocuments, sites } from "../../db";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * The site builder's actions (Phase D, D51 — `docs/BUILDER.md` §3).
 *
 * The editor, the HTTP API, the brand agent and MCP all change a design
 * through these and nothing else. Every draft edit:
 *
 * 1. takes the site's design row `FOR UPDATE` and checks the edit lease
 *    (`lockDesign`) — one writer at a time, and the agent holds the pen while
 *    a turn runs;
 * 2. applies one pure tree operation (`lib/builder/tree.ts`) and validates the
 *    whole tree;
 * 3. saves the draft and bumps `draftRevision`, which the live preview polls.
 *
 * **Nothing here changes what shoppers see except `builder.publish`.** That is
 * why the draft edits may carry `agentExecution: "draft"` (D51) and publish,
 * restore, discard and page deletion may not.
 */

const siteId = z.number().int().positive();
const pageId = z.number().int().positive();
const nodeId = z.string().regex(/^n_[a-z0-9]{10}$/, "A node id looks like n_ followed by 10 characters.");

/** A tree error as the API reports it: a bad edit is 400, a stale id is 404. */
function treeOp<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TreeError) {
      throw new ApiError(e.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR", e.code === "NOT_FOUND" ? 404 : 400, e.message, e.details);
    }
    throw e;
  }
}

/**
 * Lock, edit one page's draft tree, save, bump. Returns the operation's output
 * and the new revision; an operation that changes nothing saves nothing.
 */
async function editPage<T extends { root: PageNode }>(
  ctx: ActionContext,
  site: number,
  page: number,
  op: (tree: PageNode) => T,
  changed: (out: T) => boolean = () => true,
): Promise<{ out: T; revision: number | null }> {
  await lockDesign(ctx, site);
  const doc = await loadPage(ctx.db, site, page);
  const out = treeOp(() => op(doc.draftTree));
  if (!changed(out)) return { out, revision: null };
  await saveTree(ctx, doc.id, out.root);
  return { out, revision: await bumpRevision(ctx, site) };
}

const pageEntity = (id: number) => ({ entity: "sitePage", entityId: String(id) });

// ---------------------------------------------------------------------------
// Starting a design
// ---------------------------------------------------------------------------

export const startDesign = defineAction({
  id: "builder.startDesign",
  description:
    "Start a site's design if it has none: its draft theme, and a home page that reproduces the " +
    "current storefront. Idempotent — an already-started design is returned unchanged. Nothing a " +
    "shopper sees changes until the design is published.",
  input: z.object({ siteId }).strict(),
  permission: "cms.write",
  riskTier: "low",
  async run({ siteId: id }, ctx) {
    const site = await ownedSite(ctx.db, ctx.actor.orgId!, id);
    const [existing] = await ctx.db.select().from(siteDesigns).where(eq(siteDesigns.siteId, id)).limit(1);
    if (existing) return { siteId: id, started: false };

    await ctx.db
      .insert(siteDesigns)
      .values({ siteId: id, draftThemeId: site.themeId })
      .onConflictDoNothing();
    await ctx.db
      .insert(siteDocuments)
      .values({
        siteId: id,
        kind: "page",
        handle: HOME_HANDLE,
        title: "Home",
        draftTree: defaultHomeTree(site),
      })
      .onConflictDoNothing();
    ctx.recordDiff({ entity: "siteDesign", entityId: String(id), path: "started", before: false, after: true });
    return { siteId: id, started: true };
  },
});

// ---------------------------------------------------------------------------
// Tree edits — the brand agent may run these itself (D51)
// ---------------------------------------------------------------------------

export const addBlock = defineAction({
  id: "builder.addBlock",
  description:
    "Add one block to a page's draft, inside parentId at index (end when omitted). Props are " +
    "merged over the block type's defaults; read the block registry for each type's props. " +
    "Returns the new node's id.",
  input: z
    .object({
      siteId,
      pageId,
      parentId: nodeId,
      index: z.number().int().min(0).optional(),
      type: z.string().min(1).max(40),
      props: z.record(z.string(), z.unknown()).optional(),
      intent: z.string().max(200).optional(),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number };
    const result = r.result as { nodeId: string };
    return {
      actionId: "builder.removeNodes",
      input: { siteId: input.siteId, pageId: input.pageId, nodeIds: [result.nodeId] },
      // Siblings may have moved since; removing the block that was added is right regardless.
      conflictCheck: "none",
    };
  },
  async run(input, ctx) {
    const { out, revision } = await editPage(ctx, input.siteId, input.pageId, (tree) =>
      insertNodes(tree, [
        { parentId: input.parentId, index: input.index, node: { type: input.type, props: input.props, intent: input.intent } },
      ]),
    );
    const added = out.inserted[0];
    ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${added.nodeId}`, before: null, after: { type: added.type, parentId: added.parentId, index: added.index } });
    return { nodeId: added.nodeId, revision };
  },
});

const placementSchema = z
  .object({ parentId: nodeId, index: z.number().int().min(0).optional(), node: nodeInputSchema })
  .strict();

export const insertNodes_ = defineAction({
  id: "builder.insertNodes",
  description:
    "Insert whole subtrees into a page's draft — several blocks at once, nested. Each node is " +
    "{ type, props?, styles?, intent?, children? }. Use for a layout of several blocks; " +
    "builder.addBlock is simpler for one.",
  input: z.object({ siteId, pageId, placements: z.array(placementSchema).min(1).max(50) }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number };
    const result = r.result as { inserted: { nodeId: string }[] };
    return {
      actionId: "builder.removeNodes",
      input: { siteId: input.siteId, pageId: input.pageId, nodeIds: result.inserted.map((i) => i.nodeId) },
      conflictCheck: "none",
    };
  },
  async run(input, ctx) {
    const { out, revision } = await editPage(ctx, input.siteId, input.pageId, (tree) => insertNodes(tree, input.placements));
    for (const i of out.inserted) {
      ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${i.nodeId}`, before: null, after: { type: i.type, parentId: i.parentId, index: i.index } });
    }
    return { inserted: out.inserted, revision };
  },
});

export const insertPreset = defineAction({
  id: "builder.insertPreset",
  description:
    `Insert a ready-made group of blocks: ${Object.entries(PRESETS)
      .map(([k, p]) => `${k} (${p.description})`)
      .join("; ")}. Every block in it is editable afterwards.`,
  input: z
    .object({
      siteId,
      pageId,
      parentId: nodeId,
      index: z.number().int().min(0).optional(),
      preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number };
    const result = r.result as { nodeId: string };
    return { actionId: "builder.removeNodes", input: { siteId: input.siteId, pageId: input.pageId, nodeIds: [result.nodeId] }, conflictCheck: "none" };
  },
  async run(input, ctx) {
    const { out, revision } = await editPage(ctx, input.siteId, input.pageId, (tree) =>
      insertNodes(tree, [{ parentId: input.parentId, index: input.index, node: PRESETS[input.preset].node }]),
    );
    const added = out.inserted[0];
    ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${added.nodeId}`, before: null, after: { type: added.type, preset: input.preset, parentId: added.parentId, index: added.index } });
    return { nodeId: added.nodeId, revision };
  },
});

export const removeNodes_ = defineAction({
  id: "builder.removeNodes",
  description: "Remove blocks, and everything inside them, from a page's draft. Undoable.",
  input: z.object({ siteId, pageId, nodeIds: z.array(nodeId).min(1).max(50) }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  /** The removed subtrees, ids and all, put back where they were. */
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number };
    const result = r.result as { removed: Removed[] };
    if (!result?.removed?.length) return null;
    return {
      actionId: "builder.insertNodes",
      input: {
        siteId: input.siteId,
        pageId: input.pageId,
        placements: result.removed.map((x) => ({ parentId: x.parentId, index: x.index, node: x.node })),
      },
      conflictCheck: "none",
    };
  },
  async run(input, ctx) {
    const { out, revision } = await editPage(ctx, input.siteId, input.pageId, (tree) => removeNodes(tree, input.nodeIds));
    for (const x of out.removed) {
      ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${x.node.id}`, before: { type: x.node.type, parentId: x.parentId, index: x.index }, after: null });
    }
    return { removed: out.removed, revision };
  },
});

export const moveNode_ = defineAction({
  id: "builder.moveNode",
  description: "Move a block to another place in the page: into parentId at index (end when omitted).",
  input: z.object({ siteId, pageId, nodeId, parentId: nodeId, index: z.number().int().min(0).optional() }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number; nodeId: string };
    const result = r.result as { from: { parentId: string; index: number } };
    return {
      actionId: "builder.moveNode",
      input: { siteId: input.siteId, pageId: input.pageId, nodeId: input.nodeId, parentId: result.from.parentId, index: result.from.index },
      conflictCheck: "none",
    };
  },
  async run(input, ctx) {
    const { out, revision } = await editPage(
      ctx,
      input.siteId,
      input.pageId,
      (tree) => moveNode(tree, input.nodeId, input.parentId, input.index),
      (o) => o.from.parentId !== o.to.parentId || o.from.index !== o.to.index,
    );
    if (revision !== null) {
      ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${input.nodeId}.position`, before: out.from, after: out.to });
    }
    return { from: out.from, to: out.to, revision };
  },
});

export const duplicateNode_ = defineAction({
  id: "builder.duplicateNode",
  description: "Copy a block and everything inside it, placing the copy right after the original.",
  input: z.object({ siteId, pageId, nodeId }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number };
    const result = r.result as { nodeId: string };
    return { actionId: "builder.removeNodes", input: { siteId: input.siteId, pageId: input.pageId, nodeIds: [result.nodeId] }, conflictCheck: "none" };
  },
  async run(input, ctx) {
    const { out, revision } = await editPage(ctx, input.siteId, input.pageId, (tree) => duplicateNode(tree, input.nodeId));
    ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${out.newId}`, before: null, after: { copyOf: input.nodeId, parentId: out.parentId, index: out.index } });
    return { nodeId: out.newId, revision };
  },
});

export const setProps_ = defineAction({
  id: "builder.setProps",
  description:
    "Change a block's content: the props given are merged in, `unset` removes optional ones, and " +
    "`intent` sets the block's note about what it is for (null clears it). Validated against the " +
    "block type's schema.",
  input: z
    .object({
      siteId,
      pageId,
      nodeId,
      props: z.record(z.string(), z.unknown()).default({}),
      unset: z.array(z.string().max(60)).max(20).optional(),
      intent: z.string().max(200).nullable().optional(),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  /** Every changed prop back to its value before; a prop that did not exist is unset again. */
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number; nodeId: string };
    const props: Record<string, unknown> = {};
    const unset: string[] = [];
    let intent: string | null | undefined;
    for (const d of r.diff) {
      const prefix = `nodes.${input.nodeId}.`;
      if (!d.path.startsWith(prefix)) continue;
      const rest = d.path.slice(prefix.length);
      if (rest === "intent") intent = (d.before as string | null) ?? null;
      else if (rest.startsWith("props.")) {
        const key = rest.slice("props.".length);
        if (d.before === null || d.before === undefined) unset.push(key);
        else props[key] = d.before;
      }
    }
    if (Object.keys(props).length === 0 && unset.length === 0 && intent === undefined) return null;
    return {
      actionId: "builder.setProps",
      input: { siteId: input.siteId, pageId: input.pageId, nodeId: input.nodeId, props, ...(unset.length ? { unset } : {}), ...(intent !== undefined ? { intent } : {}) },
    };
  },
  async run(input, ctx) {
    let intentBefore: string | null | undefined;
    const { out, revision } = await editPage(
      ctx,
      input.siteId,
      input.pageId,
      (tree) => {
        const step = setProps(tree, input.nodeId, input.props, input.unset);
        if (input.intent === undefined) return step;
        const withIntent = setIntent(step.root, input.nodeId, input.intent);
        intentBefore = withIntent.before;
        return { root: withIntent.root, changes: step.changes };
      },
      (o) => o.changes.length > 0 || (input.intent !== undefined && (intentBefore ?? null) !== (input.intent || null)),
    );
    for (const c of out.changes) {
      ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${input.nodeId}.props.${c.key}`, before: c.before, after: c.after });
    }
    if (input.intent !== undefined && (intentBefore ?? null) !== (input.intent || null)) {
      ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${input.nodeId}.intent`, before: intentBefore ?? null, after: input.intent || null });
    }
    return { nodeId: input.nodeId, changed: out.changes.map((c) => c.key), revision };
  },
});

const stylePatchSchema = z
  .object(
    Object.fromEntries(Object.entries(styleSchema.shape).map(([k, v]) => [k, (v as z.ZodOptional<z.ZodType>).unwrap().nullable().optional()])),
  )
  .strict();

export const setStyles_ = defineAction({
  id: "builder.setStyles",
  description:
    "Set a block's style tokens at one breakpoint (base = all screens; sm/md/lg override from " +
    "640/768/1024px up). Values are token names — spacing xs–3xl, colours bg/surface/fg/muted/" +
    "border/accent/accentText, sizes sm–4xl — never CSS. null clears a token.",
  input: z.object({ siteId, pageId, nodeId, breakpoint: z.enum(BREAKPOINTS).default("base"), styles: stylePatchSchema }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number; nodeId: string; breakpoint?: string };
    const bp = input.breakpoint ?? "base";
    const styles: Record<string, unknown> = {};
    const prefix = `nodes.${input.nodeId}.styles.${bp}.`;
    for (const d of r.diff) if (d.path.startsWith(prefix)) styles[d.path.slice(prefix.length)] = d.before ?? null;
    if (Object.keys(styles).length === 0) return null;
    return { actionId: "builder.setStyles", input: { siteId: input.siteId, pageId: input.pageId, nodeId: input.nodeId, breakpoint: bp, styles } };
  },
  async run(input, ctx) {
    const { out, revision } = await editPage(
      ctx,
      input.siteId,
      input.pageId,
      (tree) => setStyles(tree, input.nodeId, input.breakpoint, input.styles),
      (o) => o.changes.length > 0,
    );
    for (const c of out.changes) {
      ctx.recordDiff({ ...pageEntity(input.pageId), path: `nodes.${input.nodeId}.styles.${input.breakpoint}.${c.key}`, before: c.before, after: c.after });
    }
    return { nodeId: input.nodeId, changed: out.changes.map((c) => c.key), revision };
  },
});

// ---------------------------------------------------------------------------
// Theme and tokens
// ---------------------------------------------------------------------------

const themeId = z.enum(["studio", "atlas", "noir", "bloom"]);

export const setTheme = defineAction({
  id: "builder.setTheme",
  description:
    "Choose the draft's base theme — studio, atlas, noir or bloom. Token overrides stay applied on " +
    "top of whichever theme is chosen.",
  input: z.object({ siteId, themeId }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number };
    const d = r.diff.find((x) => x.path === "draftThemeId");
    if (!d) return null;
    return { actionId: "builder.setTheme", input: { siteId: input.siteId, themeId: d.before } };
  },
  async run(input, ctx) {
    const design = await lockDesign(ctx, input.siteId);
    if (design.draftThemeId === input.themeId) return { themeId: input.themeId, revision: null };
    await ctx.db.update(siteDesigns).set({ draftThemeId: input.themeId }).where(eq(siteDesigns.siteId, input.siteId));
    ctx.recordDiff({ entity: "siteDesign", entityId: String(input.siteId), path: "draftThemeId", before: design.draftThemeId, after: input.themeId });
    return { themeId: input.themeId, revision: await bumpRevision(ctx, input.siteId) };
  },
});

export const setThemeTokens = defineAction({
  id: "builder.setThemeTokens",
  description:
    "Override design tokens in the draft: colours as #RRGGBB (background, surface, foreground, " +
    "muted, border, accent, accentText), fonts from the allowed list (fontBody, fontDisplay), " +
    "radius and maxWidth from their scales. null returns a token to the theme's own value. The " +
    "result reports text pairs below WCAG AA contrast.",
  input: z.object({ siteId, tokens: designTokensPatchSchema }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number };
    const tokens: Record<string, unknown> = {};
    for (const d of r.diff) if (d.path.startsWith("draftTokens.")) tokens[d.path.slice("draftTokens.".length)] = d.before ?? null;
    if (Object.keys(tokens).length === 0) return null;
    return { actionId: "builder.setThemeTokens", input: { siteId: input.siteId, tokens } };
  },
  async run(input, ctx) {
    const design = await lockDesign(ctx, input.siteId);
    const before = (design.draftTokens ?? {}) as DesignTokens;
    let next: DesignTokens;
    try {
      next = applyTokenPatch(before, input.tokens);
    } catch (e) {
      throw new ApiError("VALIDATION_ERROR", 400, e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : "Invalid tokens.");
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(next)]);
    const changes = [...keys].filter((k) => JSON.stringify(before[k as keyof DesignTokens] ?? null) !== JSON.stringify(next[k as keyof DesignTokens] ?? null));
    const contrast = checkTheme(resolveTheme(design.draftThemeId, next));
    if (changes.length === 0) return { tokens: next, contrast, revision: null };

    await ctx.db.update(siteDesigns).set({ draftTokens: next }).where(eq(siteDesigns.siteId, input.siteId));
    for (const k of changes) {
      ctx.recordDiff({ entity: "siteDesign", entityId: String(input.siteId), path: `draftTokens.${k}`, before: before[k as keyof DesignTokens] ?? null, after: next[k as keyof DesignTokens] ?? null });
    }
    return { tokens: next, contrast, revision: await bumpRevision(ctx, input.siteId) };
  },
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const handle = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, digits and single hyphens, like about-us.")
  .max(60)
  .refine((h) => h !== HOME_HANDLE, "The home page already exists.");

const seoSchema = z
  .object({
    title: z.string().max(120).optional(),
    description: z.string().max(320).optional(),
    noindex: z.boolean().optional(),
  })
  .strict();

export const createPage = defineAction({
  id: "builder.createPage",
  description:
    "Create a page in the draft, served at /pages/{handle} once published. It starts with one " +
    "section holding its title as the heading.",
  input: z.object({ siteId, handle, title: z.string().trim().min(1).max(120) }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number };
    const result = r.result as { pageId: number };
    return { actionId: "builder.deletePage", input: { siteId: input.siteId, pageId: result.pageId }, conflictCheck: "none" };
  },
  async run(input, ctx) {
    await lockDesign(ctx, input.siteId);
    const [taken] = await ctx.db
      .select({ id: siteDocuments.id, draftDeleted: siteDocuments.draftDeleted })
      .from(siteDocuments)
      .where(and(eq(siteDocuments.siteId, input.siteId), eq(siteDocuments.kind, "page"), eq(siteDocuments.handle, input.handle)))
      .limit(1);
    if (taken) {
      throw conflict(
        taken.draftDeleted
          ? `A deleted page already uses /pages/${input.handle}; restore it instead, or pick another handle.`
          : `A page already uses /pages/${input.handle}.`,
      );
    }
    const [row] = await ctx.db
      .insert(siteDocuments)
      .values({ siteId: input.siteId, kind: "page", handle: input.handle, title: input.title, draftTree: blankPageTree(input.title) })
      .returning({ id: siteDocuments.id });
    ctx.recordDiff({ ...pageEntity(row.id), path: "page", before: null, after: { handle: input.handle, title: input.title } });
    return { pageId: row.id, revision: await bumpRevision(ctx, input.siteId) };
  },
});

export const updatePage = defineAction({
  id: "builder.updatePage",
  description:
    "Change a page's title, handle (its /pages/{handle} address) or SEO title and description in " +
    "the draft. The home page's handle cannot change.",
  input: z.object({ siteId, pageId, title: z.string().trim().min(1).max(120).optional(), handle: handle.optional(), seo: seoSchema.optional() }).strict(),
  permission: "cms.write",
  riskTier: "low",
  agentExecution: "draft",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number };
    const back: Record<string, unknown> = {};
    for (const d of r.diff) if (["title", "handle", "seo"].includes(d.path)) back[d.path] = d.before;
    if (Object.keys(back).length === 0) return null;
    return { actionId: "builder.updatePage", input: { siteId: input.siteId, pageId: input.pageId, ...back } };
  },
  async run(input, ctx) {
    await lockDesign(ctx, input.siteId);
    const doc = await loadPage(ctx.db, input.siteId, input.pageId);
    if (input.handle !== undefined && doc.handle === HOME_HANDLE) throw conflict("The home page's address cannot change.");

    const next: { title?: string; handle?: string; seo?: PageSeo } = {};
    if (input.title !== undefined && input.title !== doc.title) next.title = input.title;
    if (input.handle !== undefined && input.handle !== doc.handle) {
      const [taken] = await ctx.db
        .select({ id: siteDocuments.id })
        .from(siteDocuments)
        .where(and(eq(siteDocuments.siteId, input.siteId), eq(siteDocuments.kind, doc.kind), eq(siteDocuments.handle, input.handle)))
        .limit(1);
      if (taken) throw conflict(`A page already uses /pages/${input.handle}.`);
      next.handle = input.handle;
    }
    if (input.seo !== undefined && JSON.stringify(input.seo) !== JSON.stringify(doc.seo ?? {})) next.seo = input.seo;
    if (Object.keys(next).length === 0) return { pageId: doc.id, revision: null };

    await ctx.db.update(siteDocuments).set({ ...next, updatedAt: new Date() }).where(eq(siteDocuments.id, doc.id));
    for (const [k, v] of Object.entries(next)) {
      ctx.recordDiff({ ...pageEntity(doc.id), path: k, before: (doc as Record<string, unknown>)[k] ?? null, after: v });
    }
    return { pageId: doc.id, revision: await bumpRevision(ctx, input.siteId) };
  },
});

/** Human-only: deleting is a medium-risk change the brand agent may suggest but not make. */
export const deletePage = defineAction({
  id: "builder.deletePage",
  description: "Delete a page from the draft. It keeps serving until the next publish. The home page cannot be deleted.",
  input: z.object({ siteId, pageId }).strict(),
  permission: "cms.write",
  riskTier: "medium",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number };
    return { actionId: "builder.restorePage", input: { siteId: input.siteId, pageId: input.pageId } };
  },
  async run(input, ctx) {
    await lockDesign(ctx, input.siteId);
    const doc = await loadPage(ctx.db, input.siteId, input.pageId);
    if (doc.handle === HOME_HANDLE && doc.kind === "page") throw conflict("The home page cannot be deleted.");
    await ctx.db.update(siteDocuments).set({ draftDeleted: true, updatedAt: new Date() }).where(eq(siteDocuments.id, doc.id));
    ctx.recordDiff({ ...pageEntity(doc.id), path: "deleted", before: false, after: true });
    return { pageId: doc.id, revision: await bumpRevision(ctx, input.siteId) };
  },
});

export const restorePage = defineAction({
  id: "builder.restorePage",
  description: "Bring back a page deleted from the draft since the last publish.",
  input: z.object({ siteId, pageId }).strict(),
  permission: "cms.write",
  riskTier: "medium",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; pageId: number };
    return { actionId: "builder.deletePage", input: { siteId: input.siteId, pageId: input.pageId } };
  },
  async run(input, ctx) {
    await lockDesign(ctx, input.siteId);
    const doc = await loadPage(ctx.db, input.siteId, input.pageId, { includeDeleted: true });
    if (!doc.draftDeleted) return { pageId: doc.id, revision: null };
    await ctx.db.update(siteDocuments).set({ draftDeleted: false, updatedAt: new Date() }).where(eq(siteDocuments.id, doc.id));
    ctx.recordDiff({ ...pageEntity(doc.id), path: "deleted", before: true, after: false });
    return { pageId: doc.id, revision: await bumpRevision(ctx, input.siteId) };
  },
});

// ---------------------------------------------------------------------------
// Publishing, discarding, restoring — never the agent's
// ---------------------------------------------------------------------------

/** Every draft page plus the draft theme, checked as publish would check them. */
export async function draftChecks(ctx: Pick<ActionContext, "db">, site: number, design: { draftThemeId: string; draftTokens: DesignTokens }) {
  const docs = await ctx.db.select().from(siteDocuments).where(eq(siteDocuments.siteId, site));
  const facts = await catalogFacts(ctx.db, site);
  const results: CheckResult[] = [];
  for (const doc of docs.filter((d) => !d.draftDeleted)) results.push(...checkPage(doc.draftTree, facts, doc.handle));
  results.push(...checkTheme(resolveTheme(design.draftThemeId, design.draftTokens)));
  return { docs, results };
}

export const publish = defineAction({
  id: "builder.publish",
  description:
    "Publish the site's draft design — every page, the theme and its tokens — to the live " +
    "storefront in one step. Runs the pre-publish checks first: errors block, warnings are " +
    "returned. A person must do this; agents and API tokens are refused.",
  input: z.object({ siteId, note: z.string().max(200).optional() }).strict(),
  permission: "cms.write",
  /** High: what shoppers see changes, so a human presses it (`docs/BUILDER.md` §12). */
  riskTier: "high",
  async run(input, ctx) {
    const design = await lockDesign(ctx, input.siteId);
    const { docs, results } = await draftChecks(ctx, input.siteId, design);
    const errors = blockingErrors(results);
    if (errors.length > 0) {
      throw new ApiError("CONFLICT", 409, `Publishing is blocked by ${errors.length} problem(s) in the draft.`, {
        reason: "checks_failed",
        checks: results,
      });
    }

    const version = design.publishedVersion + 1;
    const live = docs.filter((d) => !d.draftDeleted);
    for (const doc of live) {
      await ctx.db
        .update(siteDocuments)
        .set({
          publishedHandle: doc.handle,
          publishedTitle: doc.title,
          publishedSeo: doc.seo,
          publishedTree: doc.draftTree,
          updatedAt: new Date(),
        })
        .where(eq(siteDocuments.id, doc.id));
    }
    for (const doc of docs.filter((d) => d.draftDeleted)) {
      await ctx.db.delete(siteDocuments).where(eq(siteDocuments.id, doc.id));
    }
    await ctx.db.update(sites).set({ themeId: design.draftThemeId, updatedAt: new Date() }).where(eq(sites.id, input.siteId));
    await ctx.db
      .update(siteDesigns)
      .set({
        publishedTokens: design.draftTokens,
        publishedRevision: design.draftRevision,
        publishedVersion: version,
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(siteDesigns.siteId, input.siteId));
    await ctx.db.insert(siteDesignVersions).values({
      siteId: input.siteId,
      version,
      snapshot: {
        themeId: design.draftThemeId,
        tokens: design.draftTokens,
        documents: live.map((d) => ({ id: d.id, kind: d.kind, handle: d.handle, title: d.title, seo: d.seo, tree: d.draftTree })),
      },
      note: input.note ?? null,
      publishedBy: `${ctx.actor.type}:${ctx.actor.id}`,
    });

    ctx.recordDiff({ entity: "siteDesign", entityId: String(input.siteId), path: "publishedVersion", before: design.publishedVersion, after: version });
    return { version, pages: live.length, removedPages: docs.length - live.length, warnings: results };
  },
});

export const discardDraft = defineAction({
  id: "builder.discardDraft",
  description:
    "Throw away every unpublished change: pages, theme and tokens go back to what is live. Pages " +
    "never published are removed. Cannot be undone.",
  input: z.object({ siteId }).strict(),
  permission: "cms.write",
  riskTier: "medium",
  async run(input, ctx) {
    const design = await lockDesign(ctx, input.siteId);
    const site = await ownedSite(ctx.db, ctx.actor.orgId!, input.siteId);
    const docs = await ctx.db.select().from(siteDocuments).where(eq(siteDocuments.siteId, input.siteId));
    for (const doc of docs) {
      if (doc.publishedTree) {
        await ctx.db
          .update(siteDocuments)
          .set({
            draftTree: doc.publishedTree,
            handle: doc.publishedHandle ?? doc.handle,
            title: doc.publishedTitle ?? doc.title,
            seo: doc.publishedSeo ?? {},
            draftDeleted: false,
            updatedAt: new Date(),
          })
          .where(eq(siteDocuments.id, doc.id));
      } else if (doc.handle === HOME_HANDLE && doc.kind === "page") {
        await ctx.db.update(siteDocuments).set({ draftTree: defaultHomeTree(site), draftDeleted: false }).where(eq(siteDocuments.id, doc.id));
      } else {
        await ctx.db.delete(siteDocuments).where(eq(siteDocuments.id, doc.id));
      }
    }
    await ctx.db.update(siteDesigns).set({ draftThemeId: site.themeId, draftTokens: design.publishedTokens }).where(eq(siteDesigns.siteId, input.siteId));
    const revision = await bumpRevision(ctx, input.siteId);
    // Nothing differs from what is live now.
    await ctx.db.update(siteDesigns).set({ publishedRevision: revision }).where(eq(siteDesigns.siteId, input.siteId));
    ctx.recordDiff({ entity: "siteDesign", entityId: String(input.siteId), path: "draft", before: "edited", after: "discarded" });
    return { revision };
  },
});

export const restoreVersion = defineAction({
  id: "builder.restoreVersion",
  description:
    "Copy a published version back into the draft, replacing the current draft. It does not go " +
    "live until published. Cannot be undone.",
  input: z.object({ siteId, version: z.number().int().positive() }).strict(),
  permission: "cms.write",
  riskTier: "medium",
  async run(input, ctx) {
    await lockDesign(ctx, input.siteId);
    const [snap] = await ctx.db
      .select()
      .from(siteDesignVersions)
      .where(and(eq(siteDesignVersions.siteId, input.siteId), eq(siteDesignVersions.version, input.version)))
      .limit(1);
    if (!snap) throw notFound("Version");

    const docs = await ctx.db.select().from(siteDocuments).where(eq(siteDocuments.siteId, input.siteId));
    const wanted = new Map(snap.snapshot.documents.map((d) => [d.id, d]));
    // Pages not in the version leave the draft first, so their handles are free to be reused.
    for (const doc of docs.filter((d) => !wanted.has(d.id))) {
      if (doc.publishedTree) await ctx.db.update(siteDocuments).set({ draftDeleted: true }).where(eq(siteDocuments.id, doc.id));
      else await ctx.db.delete(siteDocuments).where(eq(siteDocuments.id, doc.id));
    }
    for (const d of snap.snapshot.documents) {
      const existing = docs.find((x) => x.id === d.id);
      const values = { handle: d.handle, title: d.title, seo: d.seo, draftTree: d.tree, draftDeleted: false, updatedAt: new Date() };
      if (existing) await ctx.db.update(siteDocuments).set(values).where(eq(siteDocuments.id, d.id));
      else await ctx.db.insert(siteDocuments).values({ siteId: input.siteId, kind: d.kind as "page", ...values });
    }
    await ctx.db
      .update(siteDesigns)
      .set({ draftThemeId: snap.snapshot.themeId as "studio", draftTokens: snap.snapshot.tokens })
      .where(eq(siteDesigns.siteId, input.siteId));
    ctx.recordDiff({ entity: "siteDesign", entityId: String(input.siteId), path: "draft", before: null, after: { restoredVersion: input.version } });
    return { version: input.version, revision: await bumpRevision(ctx, input.siteId) };
  },
});
