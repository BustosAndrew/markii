/**
 * Blog post rules — pure, so the actions, the storefront and a test agree.
 */
import { articleText, autoExcerpt } from "@markii/renderer/article";

export const BLOG_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BLOG_HANDLE_MAX = 80;
export const BLOG_TITLE_MAX = 200;
export const BLOG_EXCERPT_MAX = 300;
export const BLOG_POSTS_PER_SITE = 5_000;
/** Posts per page on `/blog`. */
export const BLOG_PAGE_SIZE = 20;
/** Posts in `/blog/feed.xml`. */
export const BLOG_FEED_SIZE = 20;

export type PostStatus = "draft" | "scheduled" | "published";

/**
 * Derived per request, never stored: a scheduled post goes live because the
 * clock passed its time, not because anything ran.
 */
export function postStatus(publishedAt: Date | null, now = new Date()): PostStatus {
  if (!publishedAt) return "draft";
  return publishedAt.getTime() > now.getTime() ? "scheduled" : "published";
}

export function postVisible(publishedAt: Date | null, now = new Date()): boolean {
  return postStatus(publishedAt, now) === "published";
}

/** A handle from a title: what the post is called, in its address. */
export function handleFromTitle(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, BLOG_HANDLE_MAX)
    .replace(/-+$/, "");
  return base || "post";
}

/** The first free handle of `base`, `base-2`, `base-3`… among `taken`. */
export function freeHandle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, BLOG_HANDLE_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type PublishProblem = { code: string; message: string };

/**
 * What stops a post going live. Few on purpose: a blog is the merchant's
 * writing, and a check that second-guesses it teaches them to ignore checks.
 */
export function publishProblems(post: { title: string; body: string; coverImage: string | null; coverAlt: string }): {
  errors: PublishProblem[];
  warnings: PublishProblem[];
} {
  const errors: PublishProblem[] = [];
  const warnings: PublishProblem[] = [];
  if (articleText(post.body).length === 0) errors.push({ code: "EMPTY_POST", message: "The post has no text yet." });
  if (post.coverImage && !post.coverAlt.trim()) {
    warnings.push({ code: "MISSING_ALT", message: "The cover image has no alt text — describe it for anyone who cannot see it." });
  }
  return { errors, warnings };
}

type ExcerptSource = { excerpt: string; body: string; requiresTierId?: number | null };

/**
 * The excerpt a shopper and an agent see: the merchant's, or the post's opening
 * words — **except on a members-only post**, whose opening words are the paid
 * content itself. There it is the merchant's excerpt or nothing, and every
 * public surface (the blog index, the feed, the read API, `llms.txt`, link
 * previews) goes through here, so none can leak the body by taking the default.
 */
export function excerptOf(post: ExcerptSource): string {
  if (post.requiresTierId != null) return post.excerpt.trim();
  return post.excerpt.trim() || autoExcerpt(post.body);
}

/** The description search engines and link previews get: SEO first, then the excerpt. */
export function descriptionOf(post: ExcerptSource & { seo: { description?: string } }): string {
  return post.seo.description?.trim() || excerptOf(post);
}
