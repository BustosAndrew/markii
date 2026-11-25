import type { RenderPost } from "./catalog";

/**
 * A list of blog posts as cards — the one drawing `/blog` and the `blogPosts`
 * block share, on Markii and in an export, so a post looks the same wherever
 * it is listed. Plain links, no script.
 *
 * Dates are shown in UTC: the page is rendered on a server that cannot know
 * the shopper's zone, and `<time dateTime>` carries the exact instant.
 */

export function postDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function When({ post }: { post: RenderPost }) {
  if (post.status === "draft" || !post.publishedAt) return <>Draft — not published</>;
  if (post.status === "scheduled") return <>Scheduled for {postDateLabel(post.publishedAt)}</>;
  return <time dateTime={post.publishedAt}>{postDateLabel(post.publishedAt)}</time>;
}

export function PostList({
  posts,
  baseUrl,
  headingLevel = 2,
  showExcerpts = true,
  showImages = true,
  className,
  attrs,
}: {
  posts: RenderPost[];
  baseUrl: string;
  /** `h2` on `/blog`, under its `h1`; `h3` in a block, which usually sits under a section's `h2`. */
  headingLevel?: 2 | 3;
  showExcerpts?: boolean;
  showImages?: boolean;
  className?: string;
  /** Extra attributes for the list element — the preview's node marker. */
  attrs?: Record<string, string | undefined>;
}) {
  const root = baseUrl.replace(/\/$/, "");
  const Title = headingLevel === 3 ? "h3" : "h2";
  return (
    <ol {...attrs} className={["sf-posts", className].filter(Boolean).join(" ")} aria-label="Posts">
      {posts.map((p) => (
        <li key={p.handle} className="sf-post-card">
          <a href={`${root}/blog/${p.handle}`}>
            {showImages && p.coverImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.coverImage} alt={p.coverAlt} loading="lazy" decoding="async" />
            ) : null}
            <Title>{p.title}</Title>
            <span className="sf-muted">
              <When post={p} />
              {p.author ? ` · ${p.author}` : null}
            </span>
            {showExcerpts && p.excerpt ? <p>{p.excerpt}</p> : null}
          </a>
        </li>
      ))}
    </ol>
  );
}
