import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";
import { notFound } from "@/lib/api";
import { db, siteDesignVersions, siteDesigns, siteDocuments, type SiteDesign } from "@/lib/db";
import { blockingErrors, checkPage, checkTheme, type CheckResult } from "./checks";
import { catalogFacts, leaseActive } from "./store";
import { resolveTheme, type DesignTokens } from "./tokens";

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
      updatedAt: siteDocuments.updatedAt,
    })
    .from(siteDocuments)
    .where(eq(siteDocuments.siteId, siteId))
    .orderBy(asc(siteDocuments.id));

  const theme = resolveTheme(design.draftThemeId, design.draftTokens as DesignTokens);
  return {
    siteId,
    started: true as const,
    themeId: design.draftThemeId,
    tokens: design.draftTokens,
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
        updatedAt: d.updatedAt.toISOString(),
      })),
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
    deleted: doc.draftDeleted,
    tree: doc.draftTree,
    published: doc.publishedTree
      ? { handle: doc.publishedHandle, title: doc.publishedTitle, seo: doc.publishedSeo, tree: doc.publishedTree }
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
  for (const doc of docs.filter((d) => !d.draftDeleted)) results.push(...checkPage(doc.draftTree, facts, doc.handle));
  results.push(...checkTheme(resolveTheme(design.draftThemeId, design.draftTokens as DesignTokens)));
  return { results, blocking: blockingErrors(results).length };
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
