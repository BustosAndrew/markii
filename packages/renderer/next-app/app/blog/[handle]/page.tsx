import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleBody, articleStructuredData } from "@markii/renderer/article-view";
import { MembersGate } from "@markii/renderer/members-gate";
import { postDateLabel } from "@markii/renderer/post-list";
import { getPost, getStore, siteUrl } from "../../../lib/markii";
import { JsonLd, StorePage } from "../../../lib/page";

type Props = { params: Promise<{ handle: string }> };

/**
 * `/blog/{handle}` — one post, as Markii draws it: the title is the page's only
 * `h1`, the body's headings start at `h2`, and the `BlogPosting` structured
 * data is the route's own, so no design can remove it. A draft or scheduled
 * post is not served by Markii, so it is a 404 here until its time comes.
 *
 * A members-only post is read from Markii as the shopper (`getPost`); a
 * shopper without the tier gets its title, excerpt and a way to join, and its
 * body never reaches this server, let alone the page.
 */

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [store, post] = await Promise.all([getStore(), getPost((await params).handle)]);
  if (!store || !post) return {};
  const title = post.seo.title || `${post.title} — ${store.store.name}`;
  const image = post.seo.ogImage ?? post.coverImage ?? undefined;
  return {
    title,
    description: post.description || undefined,
    robots: post.seo.noindex ? { index: false } : undefined,
    alternates: { canonical: `${siteUrl()}/blog/${post.handle}` },
    openGraph: {
      type: "article",
      title,
      description: post.description || undefined,
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      ...(post.author ? { authors: [post.author] } : {}),
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function BlogPostRoute({ params }: Props) {
  const store = await getStore();
  const post = store ? await getPost((await params).handle) : null;
  if (!store || !post) notFound();

  const base = siteUrl();
  const url = `${base}/blog/${post.handle}`;
  const jsonLd = articleStructuredData({
    title: post.title,
    description: post.description,
    url,
    image: post.coverImage,
    author: post.author || undefined,
    publishedAt: post.publishedAt,
    modifiedAt: post.updatedAt,
    store: { name: store.store.name, url: `${base}/` },
    ...(post.membersOnly ? { membersOnly: { bodyShown: !post.locked } } : {}),
  });

  return (
    <StorePage store={store} before={<JsonLd data={jsonLd} />}>
      <main className="sf-main">
        <article className="sf-article">
          <p className="sf-crumb">
            <a href={`${base}/`}>{store.store.name}</a> / <a href={`${base}/blog`}>Blog</a>
          </p>
          <header className="sf-hero">
            <h1 className="sf-title">{post.title}</h1>
            <p className="sf-muted">
              <time dateTime={post.publishedAt}>{postDateLabel(post.publishedAt)}</time>
              {post.author ? ` · ${post.author}` : null}
            </p>
          </header>
          {post.coverImage ? (
            <figure className="sf-article-cover">
              {/* The cover is this page's largest image: fetched at once. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={post.coverImage} alt={post.coverAlt} loading="eager" fetchPriority="high" decoding="async" />
            </figure>
          ) : null}
          {post.locked ? (
            <>
              {post.excerpt ? <p className="sf-lede">{post.excerpt}</p> : null}
              <MembersGate
                what="post"
                tierName={post.gate?.tierName ?? null}
                signInHref={`${base}/account`}
                join={(post.gate?.join ?? []).map((j) => ({ name: j.name, href: `${base}/p/${j.slug}` }))}
              />
            </>
          ) : (
            <ArticleBody src={post.body} baseUrl={base} hasCover={Boolean(post.coverImage)} />
          )}
          <p className="sf-pager">
            <a href={`${base}/blog`}>← All posts</a>
          </p>
        </article>
      </main>
    </StorePage>
  );
}
