import { eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, conflict } from "../../api";
import { cssProblems } from "@markii/renderer/sanitize";
import { SAVED_BLOCKS_PER_SITE, normalizeSavedBlock } from "../../builder/saved-blocks";
import { bumpRevision, lockDesign, ownedSite } from "../../builder/store";
import {
  ASSET_REF,
  documentProblems,
  imageRefs,
  packageFromDesign,
  themePackageSchema,
  type ThemePackage,
} from "@markii/renderer/theme-package";
import { validateTree, type NodeInput } from "@markii/renderer/tree";
import type { PageNode } from "@markii/renderer/types";
import { siteDesigns, siteDocuments, siteSavedBlocks } from "../../db";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";
import { treeOp } from "./builder";

/**
 * Moving a whole design between stores (D53): `builder.copyDesign` inside one
 * org, `builder.importTheme` from a theme package file. Both replace the
 * target's draft with the package through {@link applyPackage}, so a copy and
 * an import cannot apply different rules.
 *
 * **Both are `high`**, which the registry turns into "a person, never an agent
 * or API token": a package carries theme CSS and custom HTML, and custom code
 * is a person's to write (`docs/BUILDER.md` §8). Neither publishes — the
 * imported design sits in the draft until someone presses publish, which is
 * its own `high` action.
 *
 * **Not undoable**, like `builder.restoreVersion`: the draft they replace is
 * not recorded anywhere an inverse could read it. So they refuse to overwrite
 * unpublished work unless told to (`discardUnpublished`) — the published
 * design is always restorable from history, the unpublished draft is not.
 *
 * **Head code is never written.** The target keeps its own scripts; copying a
 * script across is `builder.setHeadCode`, with its own permission and step-up.
 */

const siteId = z.number().int().positive();

export type ApplyResult = {
  revision: number;
  documents: number;
  removedDocuments: number;
  savedBlocks: { added: string[]; skipped: { name: string; reason: "name_taken" | "limit" }[] };
  /** The target's head code is never touched by a copy or import. */
  headCode: "kept";
};

async function applyPackage(
  ctx: ActionContext,
  target: number,
  pkg: ThemePackage,
  opts: { discardUnpublished: boolean; origin: Record<string, unknown> },
): Promise<ApplyResult> {
  // Everything is checked before anything is written, so a refused import changes nothing.
  const problems = documentProblems(pkg.documents);
  if (problems.length) throw new ApiError("VALIDATION_ERROR", 400, problems.join(" "), { problems });

  const unresolved = imageRefs(pkg).filter((r) => ASSET_REF.test(r.url));
  if (unresolved.length) {
    throw new ApiError("VALIDATION_ERROR", 400, "The package still holds bundled-image references; import the file through the theme-import route, which stores the images first.", {
      reason: "unresolved_assets",
      where: unresolved.map((r) => r.where),
    });
  }

  const customCss = pkg.theme.customCss.replace(/\r\n/g, "\n").trim();
  const cssIssues = cssProblems(customCss);
  if (cssIssues.length) throw new ApiError("VALIDATION_ERROR", 400, cssIssues.join(" "), { problems: cssIssues, where: "theme CSS" });

  const documents = pkg.documents.map((d) => ({ ...d, tree: treeOp(() => validateTree(d.tree as PageNode)) }));
  const blocks = pkg.savedBlocks.map((b) => ({ name: b.name, ...treeOp(() => normalizeSavedBlock(b.node)) }));

  const site = await ownedSite(ctx.db, ctx.actor.orgId!, target);
  // A store that was never designed gets a design row; the package brings its own home page.
  await ctx.db.insert(siteDesigns).values({ siteId: target, draftThemeId: site.themeId }).onConflictDoNothing();
  const design = await lockDesign(ctx, target);
  if (!opts.discardUnpublished && design.draftRevision !== design.publishedRevision) {
    throw new ApiError(
      "CONFLICT",
      409,
      "This store's design has unpublished changes, which this would replace for good. Publish or discard them first, or confirm replacing them.",
      { reason: "unpublished_changes", resolution: "Send discardUnpublished: true to replace the unpublished draft." },
    );
  }

  const existing = await ctx.db.select().from(siteDocuments).where(eq(siteDocuments.siteId, target));
  const key = (kind: string, handle: string) => `${kind}:${handle}`;
  const wanted = new Set(documents.map((d) => key(d.kind, d.handle)));

  // Documents the package lacks leave the draft first, as a restore does: a live one keeps serving until publish.
  let removedDocuments = 0;
  for (const row of existing) {
    if (wanted.has(key(row.kind, row.handle))) continue;
    if (row.draftDeleted) continue;
    removedDocuments += 1;
    if (row.publishedTree) await ctx.db.update(siteDocuments).set({ draftDeleted: true, updatedAt: new Date() }).where(eq(siteDocuments.id, row.id));
    else await ctx.db.delete(siteDocuments).where(eq(siteDocuments.id, row.id));
  }
  for (const d of documents) {
    const row = existing.find((r) => r.kind === d.kind && r.handle === d.handle);
    const values = { title: d.title, seo: d.seo, draftTree: d.tree, draftDeleted: false, updatedAt: new Date() };
    if (row) await ctx.db.update(siteDocuments).set(values).where(eq(siteDocuments.id, row.id));
    else await ctx.db.insert(siteDocuments).values({ siteId: target, kind: d.kind, handle: d.handle, ...values });
  }

  await ctx.db
    .update(siteDesigns)
    .set({ draftThemeId: pkg.theme.themeId, draftTokens: pkg.theme.tokens, draftCustomCss: customCss })
    .where(eq(siteDesigns.siteId, target));

  // Saved blocks join the library; a name the store already uses keeps the store's own.
  const have = await ctx.db.select({ name: siteSavedBlocks.name }).from(siteSavedBlocks).where(eq(siteSavedBlocks.siteId, target));
  const names = new Set(have.map((h) => h.name));
  const added: string[] = [];
  const skipped: ApplyResult["savedBlocks"]["skipped"] = [];
  for (const b of blocks) {
    if (names.has(b.name)) {
      skipped.push({ name: b.name, reason: "name_taken" });
      continue;
    }
    if (names.size >= SAVED_BLOCKS_PER_SITE) {
      skipped.push({ name: b.name, reason: "limit" });
      continue;
    }
    await ctx.db.insert(siteSavedBlocks).values({
      siteId: target,
      name: b.name,
      node: b.node as NodeInput & { type: string },
      nodeCount: b.nodeCount,
      createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
    });
    names.add(b.name);
    added.push(b.name);
  }

  ctx.recordDiff({
    entity: "siteDesign",
    entityId: String(target),
    path: "draft",
    before: null,
    after: { ...opts.origin, documents: documents.length, removedDocuments, savedBlocksAdded: added.length },
  });
  return {
    revision: await bumpRevision(ctx, target),
    documents: documents.length,
    removedDocuments,
    savedBlocks: { added, skipped },
    headCode: "kept",
  };
}

export const copyDesign = defineAction({
  id: "builder.copyDesign",
  description:
    "Copy another of this org's stores' design — theme, tokens, theme CSS, every page, template " +
    "and region, and its saved blocks — into this store's draft, replacing the draft. source: " +
    "\"published\" (what shoppers see, the default) or \"draft\". Images stay where they are; " +
    "custom scripts are not copied. Nothing goes live until published. Refuses to replace " +
    "unpublished changes unless discardUnpublished is true. A person must do this.",
  input: z
    .object({
      siteId,
      fromSiteId: siteId,
      source: z.enum(["published", "draft"]).default("published"),
      discardUnpublished: z.boolean().default(false),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "high",
  async run(input, ctx) {
    if (input.fromSiteId === input.siteId) throw conflict("Pick a different store to copy from.");
    // Both ends go through the store scope (D52): a member must reach the store they copy from, too.
    const from = await ownedSite(ctx.db, ctx.actor.orgId!, input.fromSiteId);
    const [design] = await ctx.db.select().from(siteDesigns).where(eq(siteDesigns.siteId, from.id)).limit(1);
    if (!design) throw new ApiError("CONFLICT", 409, `${from.name} has no design to copy yet.`, { reason: "no_design" });
    const docs = await ctx.db.select().from(siteDocuments).where(eq(siteDocuments.siteId, from.id));
    const saved = await ctx.db
      .select({ name: siteSavedBlocks.name, node: siteSavedBlocks.node })
      .from(siteSavedBlocks)
      .where(eq(siteSavedBlocks.siteId, from.id));
    const pkg = packageFromDesign({
      source: input.source,
      publishedThemeId: from.themeId,
      design,
      documents: docs,
      savedBlocks: saved.map((s) => ({ name: s.name, node: s.node as NodeInput })),
    });
    if (!pkg) {
      throw new ApiError("CONFLICT", 409, `${from.name} has not published a design yet. Copy its draft instead.`, {
        reason: "nothing_published",
        resolution: 'Send source: "draft".',
      });
    }
    // Round-trip the package schema so a copy and a file import accept exactly the same thing.
    const result = await applyPackage(ctx, input.siteId, themePackageSchema.parse(pkg), {
      discardUnpublished: input.discardUnpublished,
      origin: { copiedFrom: from.id, source: input.source },
    });
    return { ...result, fromSiteId: from.id, sourceHasHeadCode: (input.source === "published" ? design.publishedHeadHtml : design.draftHeadHtml) !== "" };
  },
});

export const importTheme = defineAction({
  id: "builder.importTheme",
  description:
    "Replace this store's draft design with a theme package (format \"markii.theme\", version 1): " +
    "theme, tokens, theme CSS, pages, templates, regions and saved blocks. Every image must already " +
    "be an https URL — a package file with bundled images goes through POST " +
    "/api/builder/sites/{site}/theme-import, which stores them first. Custom scripts are never " +
    "imported. Nothing goes live until published. Refuses to replace unpublished changes unless " +
    "discardUnpublished is true. A person must do this.",
  input: z
    .object({
      siteId,
      package: themePackageSchema,
      discardUnpublished: z.boolean().default(false),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "high",
  async run(input, ctx) {
    return applyPackage(ctx, input.siteId, input.package, {
      discardUnpublished: input.discardUnpublished,
      origin: { imported: input.package.name ?? "theme package" },
    });
  },
});
