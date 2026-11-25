import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { blogStructuredData } from "@markii/renderer/article-view";
import { PostList } from "@markii/renderer/post-list";
import { getPosts, getStore, siteUrl, toRenderPost } from "../../lib/markii";
import { JsonLd, StorePage } from "../../lib/page";

type Props = { searchParams: Promise<{ page?: string }> };

/**
 * `/blog` — your store's live posts, newest first, twenty to a page, read from
 * Markii and drawn with the same list Markii draws. Write posts in the Markii
 * dashboard (Blog); a scheduled post appears here when its time comes.
 */

function pageNumber(raw: string | undefined) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 1 ? n : 1;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const store = await getStore();
  if (!store) return {};
  const page = pageNumber((await searchParams).page);
  const title = `Blog — ${store.store.name}`;
  return {
    title: page > 1 ? `${title} (page ${page})` : title,
    alternates: { types: { "application/rss+xml": `${siteUrl()}/blog/feed.xml` } },
  };
}

export default async function BlogIndex({ searchParams }: Props) {
  const store = await getStore();
  const page = pageNumber((await searchParams).page);
  const list = store ? await getPosts(page) : null;
  if (!store || !list || page > list.pages) notFound();

  const base = siteUrl();
  const posts = list.posts.map(toRenderPost);
  const jsonLd = blogStructuredData({
    name: `${store.store.name} blog`,
    url: `${base}/blog`,
    posts: list.posts.map((p) => ({ title: p.title, url: `${base}/blog/${p.handle}`, publishedAt: p.publishedAt })),
  });

  return (
    <StorePage store={store} before={<JsonLd data={jsonLd} />}>
      <main className="sf-main">
        <p className="sf-crumb">
          <a href={`${base}/`}>{store.store.name}</a> / Blog
        </p>
        <header className="sf-hero">
          <h1 className="sf-title">Blog</h1>
          {posts.length === 0 ? <p className="sf-lede">No posts yet.</p> : null}
        </header>
        {posts.length > 0 ? <PostList posts={posts} baseUrl={base} /> : null}
        {list.pages > 1 ? (
          <nav className="sf-pager" aria-label="Blog pages">
            {page > 1 ? <a href={`${base}/blog${page === 2 ? "" : `?page=${page - 1}`}`} rel="prev">← Newer posts</a> : <span />}
            {page < list.pages ? <a href={`${base}/blog?page=${page + 1}`} rel="next">Older posts →</a> : <span />}
          </nav>
        ) : null}
      </main>
    </StorePage>
  );
}
