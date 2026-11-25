import type { PageSeo } from "@markii/renderer/types";
import { invokeAction } from "./actions";
import { apiGet } from "./client";
import { callWhenLive } from "./planned";

const SECTION = "API §19 (blog)";

/**
 * ✅ LIVE — the store's blog (2026-11-22). **Needs migration 0052.**
 *
 * Posts are **not** part of the draft design: edits to a live post are live
 * when saved, and publishing a post publishes that post only. `status` is
 * derived per request from `publishedAt` — `draft` (null), `scheduled`
 * (future), `published` (past) — so a scheduled post goes live on its own.
 *
 * The body is Markdown: paragraphs, `##`/`###` headings (`#` reads as `##` —
 * the title is the page's only h1), `-`/`1.` lists, `**bold**`, `*italic*`,
 * `` `code` ``, `[links](/path)`, `![alt](https://…)` on its own line, `> `
 * quotes, ``` fences and `---`. Raw HTML shows as text. Preview a draft in the
 * builder preview at `/blog/{handle}`, where drafts and scheduled posts show.
 */
const BLOG_API_LIVE = true;

export type PostStatus = "draft" | "scheduled" | "published";

export type BlogPostSummary = {
  id: number;
  handle: string;
  title: string;
  /** The merchant's excerpt, or the body's opening words when they wrote none. */
  excerpt: string;
  coverImage: string | null;
  coverAlt: string;
  author: string;
  status: PostStatus;
  publishedAt: string | null;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type BlogPost = Omit<BlogPostSummary, "excerpt"> & {
  body: string;
  /**
   * **On a single post this is what the merchant typed** — `""` when they wrote
   * none. Unlike the list's `excerpt`, it never holds the automatic one, so an
   * editor can fill its field from it and an empty field stays empty.
   */
  excerpt: string;
  /** The excerpt shoppers see: the merchant's, or the body's opening words when they wrote none. */
  autoExcerpt: string;
  seo: PageSeo;
  /** What search engines and link previews get: SEO description, else the excerpt. */
  description: string;
};

export function listBlogPosts(
  site: number | string,
  query: { q?: string; status?: PostStatus; limit?: number; offset?: number } = {},
  init?: RequestInit,
) {
  return callWhenLive(BLOG_API_LIVE, SECTION, () =>
    apiGet<{ siteId: number; total: number; items: BlogPostSummary[] }>(`/api/sites/${site}/blog/posts`, query, init),
  );
}

export function getBlogPost(site: number | string, postId: number, init?: RequestInit) {
  return callWhenLive(BLOG_API_LIVE, SECTION, () => apiGet<BlogPost>(`/api/sites/${site}/blog/posts/${postId}`, undefined, init));
}

type PostResult = { postId: number; siteId: number; handle: string; title: string; status: PostStatus; publishedAt: string | null };

export type BlogPostFields = {
  title: string;
  handle?: string;
  excerpt?: string;
  body?: string;
  /** https only, or null to remove. */
  coverImage?: string | null;
  coverAlt?: string;
  author?: string;
  /** Replaced whole — send every field you want kept. */
  seo?: PageSeo;
};

/** A new draft. The handle comes from the title unless given. Undoable (deletes the draft). */
export function createBlogPost(body: { siteId: number } & BlogPostFields, init?: RequestInit) {
  return invokeAction<PostResult>("blog.createPost", body, init);
}

/**
 * Only the fields given change; a live post's edits are live at once. A live
 * post's handle change leaves a redirect from the old `/blog/` address unless
 * `redirectOldLink: false`. `409 handle_taken`. Undoable.
 */
export function updateBlogPost(body: { postId: number; redirectOldLink?: boolean } & Partial<BlogPostFields>, init?: RequestInit) {
  return invokeAction<PostResult>("blog.updatePost", body, init);
}

/**
 * Live now, or at `at` (ISO 8601) to schedule. A live post keeps its date unless
 * `at` is given. `409 checks_failed` (no text yet); `warnings` (cover without alt
 * text) to show beside the result. Undoable.
 */
export function publishBlogPost(body: { postId: number; at?: string }, init?: RequestInit) {
  return invokeAction<PostResult & { warnings: { code: string; message: string }[] }>("blog.publishPost", body, init);
}

/** Back to draft (or cancel a schedule). Undoable. */
export function unpublishBlogPost(body: { postId: number }, init?: RequestInit) {
  return invokeAction<PostResult>("blog.unpublishPost", body, init);
}

/** Drafts only — a live or scheduled post answers `409`; unpublish it first. Not undoable. */
export function deleteBlogPost(body: { postId: number }, init?: RequestInit) {
  return invokeAction<{ postId: number; remaining: number }>("blog.deletePost", body, init);
}
