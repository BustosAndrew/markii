import "server-only";

import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { ApiError, notFound } from "@/lib/api";
import { collections, db, products, siteDesignVersions, siteDesigns, siteDocuments, siteSavedBlocks, type SiteDesign } from "@/lib/db";
import { blockingErrors, checkCssBudget, checkHeadCode, checkPage, checkTheme, type CheckResult } from "./checks";
import type { DesignSnapshot } from "./design-diff";
import { catalogFacts, leaseActive } from "./store";
import { resolveTheme, type DesignTokens } from "@markii/renderer/tokens";
import { REGION_HANDLES, SHARED_DOCUMENT_TITLES, type RegionHandle, type TemplateHandle } from "@markii/renderer/types";

/**
 * Reads behind the builder's REST surface (`docs/API.md` §19) and the brand
 * agent's read tools. Callers resolve the site with the org's scope first; these
 * take a site id that has already passed that check.
 */

export function leaseView(design: Pick<SiteDesign, "agentLockSessionId" | "agentLockExpiresAt">) {
  const active = leaseActive(design);
  return {
    active,
    sessionId: active ? design.agentLockSessionId : null,
    expiresAt: active ? (design.agentLockExpiresAt?.toISOString() ?? null) : null,
  };
}

export async function designRow(siteId: number): Promise<SiteDesign | null> {
  const [row] = await db.select().from(siteDesigns).where(eq(siteDesigns.siteId, siteId)).limit(1);
  return row ?? null;
}

/** The design as the editor opens it. `started: false` means `builder.startDesign` has not run. */
export async function designSummary(siteId: number) {
  const design = await designRow(siteId);
  if (!design) return { siteId, started: false as const };

  const docs = await db
    .select({
      id: siteDocuments.id,
      kind: siteDocuments.kind,
      handle: siteDocuments.handle,
      title: siteDocuments.title,
      draftDeleted: siteDocuments.draftDeleted,
      publishedHandle: siteDocuments.publishedHandle,
      requiresTierId: siteDocuments.requiresTierId,
      updatedAt: siteDocuments.updatedAt,
    })
    .from(siteDocuments)
    .where(eq(siteDocuments.siteId, siteId))
    .orderBy(asc(siteDocuments.id));

  const theme = resolveTheme(design.draftThemeId, design.draftTokens as DesignTokens);

  // Where the preview shows a template: the first product or published collection there is.
  const [[sample], [sampleCollection]] = await Promise.all([
    db
      .select({ slug: products.slug })
      .from(products)
      .where(and(eq(products.siteId, siteId), eq(products.enabled, true)))
      .orderBy(asc(products.id))
      .limit(1),
    db
      .select({ handle: collections.handle })
      .from(collections)
      .where(and(eq(collections.siteId, siteId), isNotNull(collections.publishedAt)))
      .orderBy(asc(collections.id))
      .limit(1),
  ]);
  const shared = <H extends TemplateHandle | RegionHandle>(kind: "template" | "region", handle: H, previewPath: string | null) => {
    const d = docs.find((x) => x.kind === kind && x.handle === handle);
    return {
      handle,
      title: SHARED_DOCUMENT_TITLES[handle],
      /** Null until customised; the storefront uses the built-in layout meanwhile. */
      id: d?.id ?? null,
      customized: Boolean(d && !d.draftDeleted),
      /** Reset in the draft: the built-in layout returns at the next publish. */
      deleted: d?.draftDeleted ?? false,
      published: d?.publishedHandle != null,
      previewPath,
    };
  };

  return {
    siteId,
    started: true as const,
    themeId: design.draftThemeId,
    tokens: design.draftTokens,
    /** M6: the draft's custom CSS. Written by a person only (`builder.setCustomCss` is high). */
    customCss: design.draftCustomCss,
    /** M6: the draft's head code (custom scripts), stored cleaned. Written with `builder.setHeadCode` — `cms.scripts`, a person only. */
    headHtml: design.draftHeadHtml,
    /** Whether the draft's head code differs from what is live. */
    headHtmlChanged: design.draftHeadHtml !== design.publishedHeadHtml,
    contrast: checkTheme(theme).map((c) => c.message),
    revision: design.draftRevision,
    publishedRevision: design.publishedRevision,
    hasUnpublishedChanges: design.draftRevision !== design.publishedRevision,
    publishedVersion: design.publishedVersion,
    publishedAt: design.publishedAt?.toISOString() ?? null,
    agentLock: leaseView(design),
    pages: docs
      .filter((d) => d.kind === "page")
      .map((d) => ({
        id: d.id,
        handle: d.handle,
        title: d.title,
        deleted: d.draftDeleted,
        published: d.publishedHandle !== null,
        path: d.handle === "home" ? "/" : `/pages/${d.handle}`,
        /** Members-only in the draft (§18.9); null for everyone. */
        requiresTierId: d.requiresTierId,
        updatedAt: d.updatedAt.toISOString(),
      })),
    /** M4. `previewPath` is null when the store has no product (or published collection) to show it with. */
    templates: [
      shared("template", "product", sample ? `/p/${sample.slug}` : null),
      shared("template", "collection", sampleCollection ? `/collections/${sampleCollection.handle}` : null),
    ],
    regions: REGION_HANDLES.map((h) => shared("region", h, "/")),
  };
}

export async function pageDocument(siteId: number, pageId: number) {
  const [doc] = await db
    .select()
    .from(siteDocuments)
    .where(and(eq(siteDocuments.id, pageId), eq(siteDocuments.siteId, siteId)))
    .limit(1);
  if (!doc) throw notFound("Page");
  return {
    id: doc.id,
    kind: doc.kind,
    handle: doc.handle,
    title: doc.title,
    seo: doc.seo,
    /** Members-only in the draft (§18.9, `builder.setPageAccess`); null for everyone. */
    requiresTierId: doc.requiresTierId,
    deleted: doc.draftDeleted,
    tree: doc.draftTree,
    published: doc.publishedTree
      ? { handle: doc.publishedHandle, title: doc.publishedTitle, seo: doc.publishedSeo, tree: doc.publishedTree, requiresTierId: doc.publishedRequiresTierId }
      : null,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** The checks publish would run, against the current draft. */
export async function designChecks(siteId: number): Promise<{ results: CheckResult[]; blocking: number }> {
  const design = await designRow(siteId);
  if (!design) return { results: [], blocking: 0 };
  const docs = await db.select().from(siteDocuments).where(eq(siteDocuments.siteId, siteId));
  const facts = await catalogFacts(db, siteId);
  const results: CheckResult[] = [];
  const live = docs.filter((d) => !d.draftDeleted);
  for (const doc of live) results.push(...checkPage(doc.draftTree, facts, doc.handle, doc.kind));
  results.push(...checkTheme(resolveTheme(design.draftThemeId, design.draftTokens as DesignTokens)));
  results.push(...checkCssBudget(live.map((d) => d.draftTree), design.draftCustomCss));
  results.push(...checkHeadCode(design.draftHeadHtml, design.publishedHeadHtml));
  return { results, blocking: blockingErrors(results).length };
}

/** The site's saved blocks (M7), by name. `node` is ready to pass to `builder.insertNodes`. */
export async function savedBlocks(siteId: number) {
  const rows = await db
    .select()
    .from(siteSavedBlocks)
    .where(eq(siteSavedBlocks.siteId, siteId))
    .orderBy(asc(siteSavedBlocks.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.node.type,
    nodeCount: r.nodeCount,
    node: r.node,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function designVersions(siteId: number) {
  const rows = await db
    .select({
      version: siteDesignVersions.version,
      note: siteDesignVersions.note,
      publishedBy: siteDesignVersions.publishedBy,
      createdAt: siteDesignVersions.createdAt,
    })
    .from(siteDesignVersions)
    .where(eq(siteDesignVersions.siteId, siteId))
    .orderBy(desc(siteDesignVersions.version))
    .limit(100);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** One side of a design diff: the draft, what is live, or a published version by number. */
export type DesignStateRef = "draft" | "live" | number;

export type ResolvedDesignState = {
  ref: "draft" | "version";
  /** The version number, or null for the draft. */
  version: number | null;
  /** True when this side is what the storefront serves now. */
  live: boolean;
  note: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  snapshot: DesignSnapshot;
};

/**
 * A design state in the snapshot shape `builder.publish` stores, so the draft,
 * the live design and any past version compare with `diffDesigns`. "Live" is
 * the version `publishedVersion` names — publish writes it and the published
 * columns in one transaction, so they are the same design.
 */
export async function designState(siteId: number, which: DesignStateRef): Promise<ResolvedDesignState> {
  const design = await designRow(siteId);
  if (!design) throw new ApiError("CONFLICT", 409, "This store's design has not been started.", { reason: "design_not_started" });

  if (which === "draft") {
    const docs = await db
      .select()
      .from(siteDocuments)
      .where(and(eq(siteDocuments.siteId, siteId), eq(siteDocuments.draftDeleted, false)))
      .orderBy(asc(siteDocuments.id));
    return {
      ref: "draft",
      version: null,
      live: false,
      note: null,
      publishedBy: null,
      publishedAt: null,
      snapshot: {
        themeId: design.draftThemeId,
        tokens: design.draftTokens as DesignTokens,
        customCss: design.draftCustomCss,
        headHtml: design.draftHeadHtml,
        documents: docs.map((d) => ({ id: d.id, kind: d.kind, handle: d.handle, title: d.title, seo: d.seo, tree: d.draftTree, requiresTierId: d.requiresTierId })),
      },
    };
  }

  const version = which === "live" ? design.publishedVersion : which;
  if (version < 1) {
    throw new ApiError("CONFLICT", 409, "Nothing has been published yet, so there is no live design to compare with.", {
      reason: "nothing_published",
    });
  }
  const [row] = await db
    .select()
    .from(siteDesignVersions)
    .where(and(eq(siteDesignVersions.siteId, siteId), eq(siteDesignVersions.version, version)))
    .limit(1);
  if (!row) throw notFound(`Version ${version}`);
  return {
    ref: "version",
    version: row.version,
    live: row.version === design.publishedVersion,
    note: row.note,
    publishedBy: row.publishedBy,
    publishedAt: row.createdAt.toISOString(),
    snapshot: row.snapshot,
  };
}

/**
 * Everything a theme package is built from (D53): the design row, every
 * document and the saved blocks. Null when the design was never started.
 */
export async function packageSourceRows(siteId: number) {
  const design = await designRow(siteId);
  if (!design) return null;
  const [documents, saved] = await Promise.all([
    db.select().from(siteDocuments).where(eq(siteDocuments.siteId, siteId)).orderBy(asc(siteDocuments.id)),
    db
      .select({ name: siteSavedBlocks.name, node: siteSavedBlocks.node })
      .from(siteSavedBlocks)
      .where(eq(siteSavedBlocks.siteId, siteId))
      .orderBy(asc(siteSavedBlocks.name)),
  ]);
  return { design, documents, savedBlocks: saved };
}
