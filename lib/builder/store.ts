import "server-only";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { ApiError, notFound } from "@/lib/api";
import type { ActionContext, Actor } from "@/lib/actions/types";
import {
  categories,
  collections,
  products,
  siteDesigns,
  siteDocuments,
  sites,
  type DbHandle,
  type SiteDesign,
  type SiteDocument,
} from "@/lib/db";
import { ownSites } from "@/lib/tenancy";
import type { CatalogFacts } from "./checks";
import type { PageNode } from "./types";

/**
 * The builder's data access, for use **inside registry actions only** (§22
 * rule 1): every function takes the action's own `ctx.db`, so a dry run rolls
 * back exactly what it wrote and nothing reaches the database another way.
 */

/** The site, scoped to the caller's org — a foreign id answers exactly as a missing one. */
export async function ownedSite(db: DbHandle, orgId: string, siteId: number) {
  const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), ownSites(orgId))).limit(1);
  if (!site) throw notFound("Site");
  return site;
}

export function leaseActive(design: Pick<SiteDesign, "agentLockSessionId" | "agentLockExpiresAt">, now = new Date()): boolean {
  return Boolean(design.agentLockSessionId && design.agentLockExpiresAt && design.agentLockExpiresAt > now);
}

/**
 * Whether this actor may write the draft while the lease stands (owner,
 * 2026-10-31: one writer at a time, and the agent holds the pen while it works).
 *
 * - No active lease: anyone with the permission may write — except an agent,
 *   which writes only inside a turn that holds the lease. A stopped turn has
 *   released it, so its next tool call is refused instead of landing.
 * - Active lease: only the agent session holding it.
 */
export function assertMayWrite(design: SiteDesign, actor: Actor, now = new Date()) {
  const active = leaseActive(design, now);
  if (actor.type === "agent") {
    if (!active || !actor.sessionId || design.agentLockSessionId !== actor.sessionId) {
      throw new ApiError(
        "AGENT_EDITING",
        409,
        "This turn no longer holds the editor — it was stopped or timed out. Make no further changes; tell the merchant what you had done.",
        { reason: "lease_not_held" },
      );
    }
    return;
  }
  if (active) {
    throw new ApiError(
      "AGENT_EDITING",
      409,
      "The brand agent is editing this site's design. Stop the agent to make your own changes.",
      {
        reason: "agent_holds_lease",
        sessionId: design.agentLockSessionId,
        expiresAt: design.agentLockExpiresAt?.toISOString() ?? null,
        resolution: "Press Stop in the brand agent's chat, then edit.",
      },
    );
  }
}

/**
 * Take the site's design row `FOR UPDATE` and check the caller may write.
 *
 * Every draft write starts here, so writers to one site are serialised — a
 * merchant and the agent cannot lose each other's edit — and the lease is
 * checked under the same lock that a write is about to rely on.
 */
export async function lockDesign(ctx: ActionContext, siteId: number): Promise<SiteDesign> {
  await ownedSite(ctx.db, ctx.actor.orgId!, siteId);
  const [design] = await ctx.db
    .select()
    .from(siteDesigns)
    .where(eq(siteDesigns.siteId, siteId))
    .for("update")
    .limit(1);
  if (!design) {
    throw new ApiError("CONFLICT", 409, "This site's design has not been started. Open the editor first.", {
      reason: "design_not_started",
    });
  }
  assertMayWrite(design, ctx.actor);
  return design;
}

export async function bumpRevision(ctx: ActionContext, siteId: number): Promise<number> {
  const [row] = await ctx.db
    .update(siteDesigns)
    .set({ draftRevision: sql`${siteDesigns.draftRevision} + 1`, updatedAt: new Date() })
    .where(eq(siteDesigns.siteId, siteId))
    .returning({ draftRevision: siteDesigns.draftRevision });
  return row.draftRevision;
}

export async function loadPage(
  db: DbHandle,
  siteId: number,
  pageId: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<SiteDocument> {
  const [doc] = await db
    .select()
    .from(siteDocuments)
    .where(and(eq(siteDocuments.id, pageId), eq(siteDocuments.siteId, siteId)))
    .limit(1);
  if (!doc || (doc.draftDeleted && !opts.includeDeleted)) throw notFound("Page");
  return doc;
}

export async function saveTree(ctx: ActionContext, pageId: number, tree: PageNode) {
  await ctx.db
    .update(siteDocuments)
    .set({ draftTree: tree, updatedAt: new Date() })
    .where(eq(siteDocuments.id, pageId));
}

/** What the catalogue holds, for the pre-publish checks: enabled products, categories, published collections. */
export async function catalogFacts(db: DbHandle, siteId: number): Promise<CatalogFacts> {
  const [prods, cats, colls] = await Promise.all([
    db
      .select({ slug: products.slug })
      .from(products)
      .where(and(eq(products.siteId, siteId), eq(products.enabled, true))),
    db.select({ slug: categories.slug }).from(categories).where(eq(categories.siteId, siteId)),
    db
      .select({ handle: collections.handle })
      .from(collections)
      .where(and(eq(collections.siteId, siteId), isNotNull(collections.publishedAt))),
  ]);
  return {
    productSlugs: new Set(prods.map((p) => p.slug)),
    categorySlugs: new Set(cats.map((c) => c.slug)),
    collectionHandles: new Set(colls.map((c) => c.handle)),
  };
}
