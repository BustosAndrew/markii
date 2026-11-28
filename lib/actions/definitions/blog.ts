import { and, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { ApiError, conflict, notFound } from "../../api";
import { blogPosts, sites } from "../../db";
import {
  BLOG_EXCERPT_MAX,
  BLOG_HANDLE_MAX,
  BLOG_HANDLE_PATTERN,
  BLOG_POSTS_PER_SITE,
  BLOG_TITLE_MAX,
  freeHandle,
  handleFromTitle,
  postStatus,
  postVisible,
  publishProblems,
} from "../../blog/rules";
import { assertTiersOwnedBySite } from "../../commerce/memberships";
import { movedPathDiffs, redirectMovedPath } from "../../storefront/redirect-moves";
import { ownSites, siteScope } from "../../tenancy";
import { ARTICLE_MAX, articleImageUrl } from "@markii/renderer/article";
import { pageSeoSchema } from "@markii/renderer/theme-package";
import { patchInverse } from "../inverse";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Blog posts (`docs/BUILDER.md` §15 step 12, `docs/API.md` §19). Per store
 * (`ownSites` / `siteScope`, D52), `cms.write`. Not on any agent's allowlist.
 *
 * A post is not part of the draft design: edits to a live post are live when
 * saved, and publishing one post publishes nothing else. Going live and coming
 * down are `medium` — what shoppers read changes — while drafting is `low`.
 */

const handle = z
  .string()
  .regex(BLOG_HANDLE_PATTERN, "Lowercase letters, digits and single hyphens, like spring-harvest.")
  .max(BLOG_HANDLE_MAX);
const coverImage = z
  .string()
  .max(2000)
  .refine((v) => articleImageUrl(v) !== null, "Use an https:// image URL.");
const fields = {
  title: z.string().trim().min(1).max(BLOG_TITLE_MAX),
  excerpt: z.string().max(BLOG_EXCERPT_MAX),
  body: z.string().max(ARTICLE_MAX),
  coverImage: coverImage.nullable(),
  coverAlt: z.string().max(300),
  author: z.string().trim().max(120),
  seo: pageSeoSchema,
  /** Members-only (§18.9): only holders of this tier read the body. Null: everyone. */
  requiresTierId: z.number().int().positive().nullable(),
};

async function ownedSite(ctx: ActionContext, siteId: number) {
  if (!ctx.actor.orgId) throw notFound("Site");
  const [row] = await ctx.db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, siteId), ownSites(ctx.actor.orgId)))
    .limit(1);
  if (!row) throw notFound("Site");
  return row;
}

async function ownedPost(ctx: ActionContext, postId: number) {
  if (!ctx.actor.orgId) throw notFound("Post");
  const [row] = await ctx.db
    .select()
    .from(blogPosts)
    .where(and(eq(blogPosts.id, postId), siteScope(ctx.actor.orgId, blogPosts.siteId)))
    .limit(1);
  if (!row) throw notFound("Post");
  return row;
}

function view(row: typeof blogPosts.$inferSelect) {
  return {
    postId: row.id,
    siteId: row.siteId,
    handle: row.handle,
    title: row.title,
    status: postStatus(row.publishedAt),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

export const createPost = defineAction({
  id: "blog.createPost",
  description:
    "Write a new blog post as a draft, served at /blog/{handle} once published (blog.publishPost). " +
    "The handle comes from the title unless given. The body is Markdown: paragraphs, ## and ### " +
    "headings, lists, **bold**, *italic*, [links](/path), ![images](https://…), > quotes, ``` code and ---.",
  input: z
    .object({
      siteId: z.number().int().positive(),
      handle: handle.optional(),
      title: fields.title,
      excerpt: fields.excerpt.default(""),
      body: fields.body.default(""),
      coverImage: fields.coverImage.optional(),
      coverAlt: fields.coverAlt.default(""),
      author: fields.author.default(""),
      seo: fields.seo.default({}),
      requiresTierId: fields.requiresTierId.optional(),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "low",
  undoable: true,
  inverse: (r) => {
    const result = r.result as { postId: number };
    return { actionId: "blog.deletePost", input: { postId: result.postId }, conflictCheck: "none" };
  },
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);
    const existing = await ctx.db.select({ handle: blogPosts.handle }).from(blogPosts).where(eq(blogPosts.siteId, input.siteId));
    if (existing.length >= BLOG_POSTS_PER_SITE) {
      throw new ApiError("CONFLICT", 409, `A store can keep ${BLOG_POSTS_PER_SITE} posts.`, { reason: "limit" });
    }
    const taken = new Set(existing.map((p) => p.handle));
    if (input.handle && taken.has(input.handle)) {
      throw new ApiError("CONFLICT", 409, `A post already uses /blog/${input.handle}.`, { reason: "handle_taken" });
    }
    if (input.requiresTierId) await assertTiersOwnedBySite([input.requiresTierId], input.siteId, ctx.db);
    const postHandle = input.handle ?? freeHandle(handleFromTitle(input.title), taken);
    const [row] = await ctx.db
      .insert(blogPosts)
      .values({
        siteId: input.siteId,
        handle: postHandle,
        title: input.title,
        excerpt: input.excerpt,
        body: input.body,
        coverImage: input.coverImage ?? null,
        coverAlt: input.coverAlt,
        author: input.author,
        seo: input.seo,
        requiresTierId: input.requiresTierId ?? null,
        createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
      })
      .returning();
    ctx.recordDiff({ entity: "blogPost", entityId: String(row.id), path: "post", before: null, after: { handle: row.handle, title: row.title } });
    return view(row);
  },
});

const editable = ["handle", "title", "excerpt", "body", "coverImage", "coverAlt", "author", "seo", "requiresTierId"] as const;

export const updatePost = defineAction({
  id: "blog.updatePost",
  description:
    "Change a blog post — title, handle, excerpt, Markdown body, cover image, byline, SEO, or who may " +
    "read it (requiresTierId: a membership tier, or null for everyone). Only the fields given change. " +
    "A live post's edits are live when saved. Changing a live post's handle leaves a redirect from the " +
    "old /blog/ address unless redirectOldLink is false.",
  input: z
    .object({
      postId: z.number().int().positive(),
      handle: handle.optional(),
      title: fields.title.optional(),
      excerpt: fields.excerpt.optional(),
      body: fields.body.optional(),
      coverImage: fields.coverImage.optional(),
      coverAlt: fields.coverAlt.optional(),
      author: fields.author.optional(),
      seo: fields.seo.optional(),
      requiresTierId: fields.requiresTierId.optional(),
      redirectOldLink: z.boolean().optional(),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "low",
  undoable: true,
  /** `redirect` diffs record the old link's redirect; they are not post fields to replay. */
  inverse: patchInverse({ actionId: "blog.updatePost", idField: "postId", ignore: ["redirect"] }),
  async run(input, ctx) {
    const post = await ownedPost(ctx, input.postId);
    if (input.requiresTierId) await assertTiersOwnedBySite([input.requiresTierId], post.siteId, ctx.db);
    if (input.handle !== undefined && input.handle !== post.handle) {
      const [taken] = await ctx.db
        .select({ id: blogPosts.id })
        .from(blogPosts)
        .where(and(eq(blogPosts.siteId, post.siteId), eq(blogPosts.handle, input.handle), ne(blogPosts.id, post.id)))
        .limit(1);
      if (taken) throw new ApiError("CONFLICT", 409, `A post already uses /blog/${input.handle}.`, { reason: "handle_taken" });
    }
    const current = post as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const key of editable) {
      const next = input[key];
      if (next === undefined) continue;
      if (JSON.stringify(current[key] ?? null) === JSON.stringify(next ?? null)) continue;
      changed[key] = next;
      ctx.recordDiff({ entity: "blogPost", entityId: String(post.id), path: key, before: current[key] ?? null, after: next ?? null });
    }
    if (Object.keys(changed).length === 0) return view(post);
    const [row] = await ctx.db
      .update(blogPosts)
      .set({ ...changed, updatedAt: new Date() })
      .where(eq(blogPosts.id, post.id))
      .returning();
    // Only a post shoppers could reach has an old address worth keeping.
    if (changed.handle !== undefined && postVisible(post.publishedAt) && input.redirectOldLink !== false) {
      const moved = await redirectMovedPath(ctx.db, {
        siteId: post.siteId,
        fromPath: `/blog/${post.handle}`,
        toPath: `/blog/${row.handle}`,
        createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
      });
      for (const d of movedPathDiffs(moved)) ctx.recordDiff(d);
    }
    return view(row);
  },
});

export const publishPost = defineAction({
  id: "blog.publishPost",
  description:
    "Put a blog post live — now, or at a future time (`at`, ISO 8601) to schedule it. A post already " +
    "live keeps its date unless `at` is given. Refused while the post has no text. Publishes this " +
    "post only, never the store's design.",
  input: z.object({ postId: z.number().int().positive(), at: z.string().datetime({ offset: true }).optional() }).strict(),
  permission: "cms.write",
  riskTier: "medium",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { postId: number };
    const d = r.diff.find((x) => x.path === "publishedAt");
    if (!d) return null;
    return d.before === null
      ? { actionId: "blog.unpublishPost", input: { postId: input.postId } }
      : { actionId: "blog.publishPost", input: { postId: input.postId, at: d.before as string } };
  },
  async run(input, ctx) {
    const post = await ownedPost(ctx, input.postId);
    const { errors, warnings } = publishProblems(post);
    if (errors.length > 0) {
      throw new ApiError("CONFLICT", 409, errors.map((e) => e.message).join(" "), { reason: "checks_failed", checks: errors });
    }
    const at = input.at ? new Date(input.at) : post.publishedAt && postVisible(post.publishedAt) ? post.publishedAt : new Date();
    const before = post.publishedAt?.toISOString() ?? null;
    if (before !== at.toISOString()) {
      await ctx.db.update(blogPosts).set({ publishedAt: at, updatedAt: new Date() }).where(eq(blogPosts.id, post.id));
      ctx.recordDiff({ entity: "blogPost", entityId: String(post.id), path: "publishedAt", before, after: at.toISOString() });
    }
    return { ...view({ ...post, publishedAt: at }), warnings };
  },
});

export const unpublishPost = defineAction({
  id: "blog.unpublishPost",
  description: "Take a blog post down (or cancel its schedule). It becomes a draft again; its words are kept.",
  input: z.object({ postId: z.number().int().positive() }).strict(),
  permission: "cms.write",
  riskTier: "medium",
  undoable: true,
  inverse: (r) => {
    const input = r.input as { postId: number };
    const d = r.diff.find((x) => x.path === "publishedAt");
    if (!d || d.before === null) return null;
    return { actionId: "blog.publishPost", input: { postId: input.postId, at: d.before as string } };
  },
  async run(input, ctx) {
    const post = await ownedPost(ctx, input.postId);
    if (post.publishedAt) {
      await ctx.db.update(blogPosts).set({ publishedAt: null, updatedAt: new Date() }).where(eq(blogPosts.id, post.id));
      ctx.recordDiff({ entity: "blogPost", entityId: String(post.id), path: "publishedAt", before: post.publishedAt.toISOString(), after: null });
    }
    return view({ ...post, publishedAt: null });
  },
});

export const deletePost = defineAction({
  id: "blog.deletePost",
  description:
    "Delete a blog post for good. A live one must be unpublished first, so nothing shoppers can " +
    "reach disappears in one step. Cannot be undone.",
  input: z.object({ postId: z.number().int().positive() }).strict(),
  permission: "cms.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    const post = await ownedPost(ctx, input.postId);
    if (post.publishedAt) {
      throw conflict(
        postStatus(post.publishedAt) === "scheduled"
          ? "This post is scheduled. Unpublish it first, then delete it."
          : "This post is live. Unpublish it first, then delete it.",
      );
    }
    await ctx.db.delete(blogPosts).where(eq(blogPosts.id, post.id));
    ctx.recordDiff({ entity: "blogPost", entityId: String(post.id), path: "post", before: { handle: post.handle, title: post.title }, after: null });
    const [{ remaining }] = await ctx.db.select({ remaining: count() }).from(blogPosts).where(eq(blogPosts.siteId, post.siteId));
    return { postId: post.id, remaining };
  },
});
