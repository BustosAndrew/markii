import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ApiError, notFound } from "../../api";
import { siteRedirects, sites } from "../../db";
import {
  REDIRECTS_PER_SITE,
  REDIRECT_IMPORT_MAX,
  RedirectRuleError,
  checkRedirectFrom,
  checkRedirectTarget,
  closesLoop,
} from "../../storefront/redirect-rules";
import { ownSites } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Storefront redirects (`docs/BUILDER.md` §15 step 12, `docs/API.md` §19).
 *
 * Live when saved — not part of the draft design. That is safe because a
 * redirect fires only where the storefront would answer 404
 * (`lib/storefront/redirects.ts`): it cannot take away a page that exists, so
 * there is nothing for a publish step to protect. Per store (`ownSites`, D52),
 * `cms.write`, low risk. Not on any agent's allowlist.
 */

const siteId = z.number().int().positive();
const redirectId = z.number().int().positive();

async function ownedSite(ctx: ActionContext, id: number) {
  if (!ctx.actor.orgId) throw notFound("Site");
  const [row] = await ctx.db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, id), ownSites(ctx.actor.orgId)))
    .limit(1);
  if (!row) throw notFound("Site");
  return row;
}

/** A rule refusal as the registry's validation error, naming the field. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RedirectRuleError) {
      throw new ApiError("VALIDATION_ERROR", 400, err.message, { field: err.field });
    }
    throw err;
  }
}

async function existingRules(ctx: ActionContext, site: number): Promise<Map<string, string>> {
  const rows = await ctx.db
    .select({ fromPath: siteRedirects.fromPath, toUrl: siteRedirects.toUrl })
    .from(siteRedirects)
    .where(eq(siteRedirects.siteId, site));
  return new Map(rows.map((r) => [r.fromPath, r.toUrl]));
}

function loopError(from: string) {
  return new ApiError("CONFLICT", 409, `That would send ${from} round in a loop back to itself.`, { reason: "loop" });
}

type RedirectSnapshot = { id: number; from: string; to: string; permanent: boolean };

export const createRedirect = defineAction({
  id: "redirects.create",
  description:
    "Send an old storefront link to where it lives now — a path on this store or an https URL. " +
    "Fires only when nothing else answers the old path, and is live as soon as it is saved.",
  input: z
    .object({
      siteId,
      from: z.string().min(1).max(2000),
      to: z.string().min(1).max(2000),
      permanent: z.boolean().default(true),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "low",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number };
    const result = r.result as { redirectId: number };
    return { actionId: "redirects.delete", input: { siteId: input.siteId, redirectId: result.redirectId }, conflictCheck: "none" };
  },
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);
    const from = rule(() => checkRedirectFrom(input.from));
    const to = rule(() => checkRedirectTarget(input.to));
    const rules = await existingRules(ctx, input.siteId);
    if (rules.has(from)) {
      throw new ApiError("CONFLICT", 409, `There is already a redirect from ${from}. Change that one instead.`, { reason: "from_taken" });
    }
    if (rules.size >= REDIRECTS_PER_SITE) {
      throw new ApiError("CONFLICT", 409, `A store can keep ${REDIRECTS_PER_SITE} redirects. Delete some first.`, { reason: "limit" });
    }
    if (closesLoop(from, to, rules)) throw loopError(from);
    const [row] = await ctx.db
      .insert(siteRedirects)
      .values({ siteId: input.siteId, fromPath: from, toUrl: to, permanent: input.permanent, createdBy: `${ctx.actor.type}:${ctx.actor.id}` })
      .returning({ id: siteRedirects.id });
    const after: RedirectSnapshot = { id: row.id, from, to, permanent: input.permanent };
    ctx.recordDiff({ entity: "redirect", entityId: String(row.id), path: "redirect", before: null, after });
    return { redirectId: row.id, from, to, permanent: input.permanent };
  },
});

export const updateRedirect = defineAction({
  id: "redirects.update",
  description: "Change where a redirect sends the old link, or whether it is permanent. The old link itself stays the same.",
  input: z
    .object({ siteId, redirectId, to: z.string().min(1).max(2000).optional(), permanent: z.boolean().optional() })
    .strict()
    .refine((v) => v.to !== undefined || v.permanent !== undefined, { message: "Give a new target, a new permanence, or both." }),
  permission: "cms.write",
  riskTier: "low",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { siteId: number; redirectId: number };
    const d = r.diff.find((x) => x.path === "redirect");
    const before = d?.before as RedirectSnapshot | null | undefined;
    if (!before) return null;
    return { actionId: "redirects.update", input: { siteId: input.siteId, redirectId: input.redirectId, to: before.to, permanent: before.permanent } };
  },
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);
    const [row] = await ctx.db
      .select()
      .from(siteRedirects)
      .where(and(eq(siteRedirects.id, input.redirectId), eq(siteRedirects.siteId, input.siteId)))
      .limit(1);
    if (!row) throw notFound("Redirect");
    const to = input.to === undefined ? row.toUrl : rule(() => checkRedirectTarget(input.to!));
    const permanent = input.permanent ?? row.permanent;
    const rules = await existingRules(ctx, input.siteId);
    rules.delete(row.fromPath);
    if (closesLoop(row.fromPath, to, rules)) throw loopError(row.fromPath);
    await ctx.db.update(siteRedirects).set({ toUrl: to, permanent }).where(eq(siteRedirects.id, row.id));
    const before: RedirectSnapshot = { id: row.id, from: row.fromPath, to: row.toUrl, permanent: row.permanent };
    const after: RedirectSnapshot = { id: row.id, from: row.fromPath, to, permanent };
    ctx.recordDiff({ entity: "redirect", entityId: String(row.id), path: "redirect", before, after });
    return { redirectId: row.id, from: row.fromPath, to, permanent };
  },
});

export const deleteRedirect = defineAction({
  id: "redirects.delete",
  description: "Remove a redirect. The old link answers 404 again.",
  input: z.object({ siteId, redirectId }).strict(),
  permission: "cms.write",
  riskTier: "low",
  undoable: true,
  /** The diff keeps the rule, so undo creates it again (under a new id). */
  inverse: (r) => {
    const input = r.input as { siteId: number };
    const d = r.diff.find((x) => x.path === "redirect");
    const before = d?.before as RedirectSnapshot | null | undefined;
    if (!before) return null;
    return {
      actionId: "redirects.create",
      input: { siteId: input.siteId, from: before.from, to: before.to, permanent: before.permanent },
      conflictCheck: "none",
    };
  },
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);
    const [row] = await ctx.db
      .delete(siteRedirects)
      .where(and(eq(siteRedirects.id, input.redirectId), eq(siteRedirects.siteId, input.siteId)))
      .returning();
    if (!row) throw notFound("Redirect");
    const before: RedirectSnapshot = { id: row.id, from: row.fromPath, to: row.toUrl, permanent: row.permanent };
    ctx.recordDiff({ entity: "redirect", entityId: String(row.id), path: "redirect", before, after: null });
    return { redirectId: row.id };
  },
});

/**
 * Many redirects at once — a moved store's old links, pasted or uploaded as a
 * list. Each row is checked on its own: a bad row is reported and skipped, the
 * rest land together. Dry-run it first to show the report before anything is
 * saved. Not undoable (a hundred creates have no single opposite); each row
 * can be deleted.
 */
export const importRedirects = defineAction({
  id: "redirects.import",
  description:
    `Add up to ${REDIRECT_IMPORT_MAX} redirects at once — a moved store's old links. Bad rows are ` +
    "reported and skipped; existing redirects from the same old link are kept unless replace is set. " +
    "Dry-run first to see the report.",
  input: z
    .object({
      siteId,
      redirects: z
        .array(z.object({ from: z.string().min(1).max(2000), to: z.string().min(1).max(2000), permanent: z.boolean().default(true) }).strict())
        .min(1)
        .max(REDIRECT_IMPORT_MAX),
      replace: z.boolean().default(false),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);
    const rules = await existingRules(ctx, input.siteId);
    const original = new Map(rules);
    const skipped: { row: number; from: string; reason: string }[] = [];
    const accepted = new Map<string, { to: string; permanent: boolean }>();

    input.redirects.forEach((r, i) => {
      let from: string;
      let to: string;
      try {
        from = checkRedirectFrom(r.from);
        to = checkRedirectTarget(r.to);
      } catch (err) {
        if (!(err instanceof RedirectRuleError)) throw err;
        skipped.push({ row: i, from: r.from, reason: err.message });
        return;
      }
      if (accepted.has(from)) {
        skipped.push({ row: i, from, reason: "The same old link appears earlier in this list." });
        return;
      }
      if (original.has(from) && !input.replace) {
        skipped.push({ row: i, from, reason: "There is already a redirect from this link." });
        return;
      }
      const trial = new Map(rules);
      trial.delete(from);
      if (closesLoop(from, to, trial)) {
        skipped.push({ row: i, from, reason: "It would send this link round in a loop." });
        return;
      }
      rules.set(from, to);
      accepted.set(from, { to, permanent: r.permanent });
    });

    const newCount = [...accepted.keys()].filter((f) => !original.has(f)).length;
    if (original.size + newCount > REDIRECTS_PER_SITE) {
      throw new ApiError("CONFLICT", 409, `A store can keep ${REDIRECTS_PER_SITE} redirects; this would make ${original.size + newCount}.`, {
        reason: "limit",
      });
    }

    const replacing = [...accepted.keys()].filter((f) => original.has(f));
    if (replacing.length > 0) {
      await ctx.db.delete(siteRedirects).where(and(eq(siteRedirects.siteId, input.siteId), inArray(siteRedirects.fromPath, replacing)));
    }
    const createdBy = `${ctx.actor.type}:${ctx.actor.id}`;
    const values = [...accepted].map(([fromPath, v]) => ({ siteId: input.siteId, fromPath, toUrl: v.to, permanent: v.permanent, createdBy }));
    for (let i = 0; i < values.length; i += 500) await ctx.db.insert(siteRedirects).values(values.slice(i, i + 500));

    const [{ total }] = await ctx.db.select({ total: count() }).from(siteRedirects).where(eq(siteRedirects.siteId, input.siteId));
    ctx.recordDiff({
      entity: "site",
      entityId: String(input.siteId),
      path: "redirects",
      before: original.size,
      after: total,
    });
    return { created: newCount, replaced: replacing.length, skipped, total };
  },
});
