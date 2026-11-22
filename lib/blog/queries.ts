import "server-only";

import { and, count, desc, eq, gt, ilike, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { blogPosts, db, type BlogPost } from "@/lib/db";
import { notFound } from "@/lib/api";
import { BLOG_PAGE_SIZE, descriptionOf, excerptOf, postStatus } from "./rules";

/**
 * Blog reads. The storefront's are "live only, as of now" — the one place
 * scheduling is decided, per request — and the builder preview sees drafts and
 * scheduled posts too, so a merchant can read a post before it goes out.
 */

function live(siteId: number, now: Date): SQL {
  return and(eq(blogPosts.siteId, siteId), isNotNull(blogPosts.publishedAt), lte(blogPosts.publishedAt, now))!;
}

/** `/blog`: newest first. `withDrafts` is the preview's, never a shopper's. */
export async function storefrontPosts(siteId: number, opts: { page?: number; withDrafts?: boolean; limit?: number } = {}) {
  const now = new Date();
  const limit = opts.limit ?? BLOG_PAGE_SIZE;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const where = opts.withDrafts ? eq(blogPosts.siteId, siteId) : live(siteId, now);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(blogPosts)
      .where(where)
      // Drafts (no date) first in the preview, then newest.
      .orderBy(sql`${blogPosts.publishedAt} desc nulls first`, desc(blogPosts.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(blogPosts).where(where),
  ]);
  return { posts: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** One post at `/blog/{handle}`, or null when shoppers cannot see it (the preview can). */
export async function storefrontPost(siteId: number, handle: string, withDrafts = false): Promise<BlogPost | null> {
  const [row] = await db
    .select()
    .from(blogPosts)
    .where(and(withDrafts ? eq(blogPosts.siteId, siteId) : live(siteId, new Date()), eq(blogPosts.handle, handle)))
    .limit(1);
  return row ?? null;
}

/** Every live post, for the sitemap and the agent documents. */
export async function livePostsForDocs(siteId: number) {
  return db
    .select()
    .from(blogPosts)
    .where(live(siteId, new Date()))
    .orderBy(desc(blogPosts.publishedAt))
    .limit(5_000);
}

export function postSummary(row: BlogPost) {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    excerpt: excerptOf(row),
    coverImage: row.coverImage,
    coverAlt: row.coverAlt,
    author: row.author,
    status: postStatus(row.publishedAt),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    path: `/blog/${row.handle}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The dashboard's list: every post, any status. */
export async function dashboardPosts(siteId: number, opts: { q?: string; status?: string; limit: number; offset: number }) {
  const now = new Date();
  const conditions: SQL[] = [eq(blogPosts.siteId, siteId)];
  if (opts.q) {
    const like = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(blogPosts.title, like), ilike(blogPosts.handle, like))!);
  }
  if (opts.status === "draft") conditions.push(sql`${blogPosts.publishedAt} is null`);
  if (opts.status === "scheduled") conditions.push(gt(blogPosts.publishedAt, now));
  if (opts.status === "published") conditions.push(lte(blogPosts.publishedAt, now));
  const where = and(...conditions);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(blogPosts)
      .where(where)
      .orderBy(sql`${blogPosts.publishedAt} desc nulls first`, desc(blogPosts.id))
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ total: count() }).from(blogPosts).where(where),
  ]);
  return { total, items: rows.map(postSummary) };
}

export async function dashboardPost(siteId: number, postId: number) {
  const [row] = await db
    .select()
    .from(blogPosts)
    .where(and(eq(blogPosts.siteId, siteId), eq(blogPosts.id, postId)))
    .limit(1);
  if (!row) throw notFound("Post");
  return { ...postSummary(row), body: row.body, excerpt: row.excerpt, autoExcerpt: excerptOf(row), seo: row.seo, description: descriptionOf(row) };
}
