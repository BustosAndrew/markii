import { and, eq, inArray } from "drizzle-orm";
import { siteRedirects, type DbHandle } from "@/lib/db";
import { REDIRECTS_PER_SITE, closesLoop, internalTargetPath, normalizeRedirectPath } from "./redirect-rules";

/**
 * A storefront address moved — a product's slug, a collection's handle, a
 * page's handle at publish — so links to the old one keep working: a redirect
 * from the old path to the new, written in the same transaction as the move.
 * What Shopify does on a handle change, and why a renamed product does not
 * lose its search ranking or the links customers already shared.
 *
 * Rules the merchant wrote are respected:
 * - **A redirect already leaving the old path is kept.** It is theirs, and it
 *   decides where that path goes now.
 * - **Redirects pointing at the old path are re-pointed at the new one**, so
 *   a shopper is sent once rather than down a chain.
 * - **A redirect from the new path back to the old is removed** — the new path
 *   answers now, and it would close a loop with the one being added. This is
 *   what a rename followed by its undo looks like.
 *
 * Takes the action's own `db` handle, so a dry run rolls it back with
 * everything else. Never throws for redirect reasons: a move is not refused
 * because its redirect could not be kept; the result says why instead.
 */

export type RedirectSnapshot = { id: number; from: string; to: string; permanent: boolean };

export type MovedPathOutcome = {
  created: RedirectSnapshot | null;
  /** Redirects that pointed at the old path, re-pointed: before → after. */
  repointed: { before: RedirectSnapshot; after: RedirectSnapshot }[];
  /** A redirect from the new path back to the old, removed. */
  removed: RedirectSnapshot | null;
  /** Why no redirect was created, when none was. */
  skipped: "same_path" | "existing_rule" | "limit" | "loop" | null;
};

export async function redirectMovedPath(
  db: DbHandle,
  opts: { siteId: number; fromPath: string; toPath: string; createdBy: string },
): Promise<MovedPathOutcome> {
  const outcome: MovedPathOutcome = { created: null, repointed: [], removed: null, skipped: null };
  const oldFrom = normalizeRedirectPath(opts.fromPath);
  const newFrom = normalizeRedirectPath(opts.toPath);
  if (oldFrom === newFrom) return { ...outcome, skipped: "same_path" };

  const rows = await db.select().from(siteRedirects).where(eq(siteRedirects.siteId, opts.siteId));
  const snap = (r: (typeof rows)[number], to = r.toUrl): RedirectSnapshot => ({ id: r.id, from: r.fromPath, to, permanent: r.permanent });

  const reverse = rows.find((r) => r.fromPath === newFrom && internalTargetPath(r.toUrl) === oldFrom);
  if (reverse) {
    await db.delete(siteRedirects).where(eq(siteRedirects.id, reverse.id));
    outcome.removed = snap(reverse);
  }
  const live = rows.filter((r) => r.id !== reverse?.id);

  const pointing = live.filter((r) => r.fromPath !== oldFrom && internalTargetPath(r.toUrl) === oldFrom);
  if (pointing.length > 0) {
    await db
      .update(siteRedirects)
      .set({ toUrl: opts.toPath })
      .where(and(eq(siteRedirects.siteId, opts.siteId), inArray(siteRedirects.id, pointing.map((r) => r.id))));
    outcome.repointed = pointing.map((r) => ({ before: snap(r), after: snap(r, opts.toPath) }));
  }

  const rules = new Map(live.map((r) => [r.fromPath, pointing.some((p) => p.id === r.id) ? opts.toPath : r.toUrl]));
  if (rules.has(oldFrom)) return { ...outcome, skipped: "existing_rule" };
  if (rules.size >= REDIRECTS_PER_SITE) return { ...outcome, skipped: "limit" };
  if (closesLoop(oldFrom, opts.toPath, rules)) return { ...outcome, skipped: "loop" };

  const [row] = await db
    .insert(siteRedirects)
    .values({ siteId: opts.siteId, fromPath: oldFrom, toUrl: opts.toPath, permanent: true, createdBy: opts.createdBy })
    .returning();
  outcome.created = snap(row);
  return outcome;
}

/** The outcome as audit diffs, under the `redirect` path the redirect actions use. */
export function movedPathDiffs(outcome: MovedPathOutcome) {
  const out: { entity: string; entityId: string; path: string; before: unknown; after: unknown }[] = [];
  if (outcome.removed) out.push({ entity: "redirect", entityId: String(outcome.removed.id), path: "redirect", before: outcome.removed, after: null });
  for (const r of outcome.repointed) out.push({ entity: "redirect", entityId: String(r.before.id), path: "redirect", before: r.before, after: r.after });
  if (outcome.created) out.push({ entity: "redirect", entityId: String(outcome.created.id), path: "redirect", before: null, after: outcome.created });
  return out;
}
