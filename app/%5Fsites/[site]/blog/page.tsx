import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { StoreFooter, StoreTop } from "@/components/storefront/store-chrome";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { renderPost, storefrontPosts } from "@/lib/blog/queries";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { pageSocialMetadata } from "@/lib/storefront-meta";
import { blogStructuredData } from "@markii/renderer/article-view";
import { PostList } from "@markii/renderer/post-list";

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ page?: string }> };

/**
 * `/blog` — the store's live posts, newest first, twenty to a page. Server
 * rendered, no island. In the builder preview drafts and scheduled posts show
 * too, labelled, so a merchant can see a post in place before it goes out.
 */

function pageNumber(raw: string | undefined) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 1 ? n : 1;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const data = await loadSite((await params).site);
  if (!data) return {};
  const page = pageNumber((await searchParams).page);
  const title = `Blog — ${data.site.name}`;
  return {
    title: page > 1 ? `${title} (page ${page})` : title,
    robots: data.site.indexed ? undefined : { index: false },
    alternates: { types: { "application/rss+xml": `${data.baseUrl.replace(/\/$/, "")}/blog/feed.xml` } },
    ...pageSocialMetadata(data, { title, path: page > 1 ? `/blog?page=${page}` : "/blog" }),
  };
}

export default async function BlogIndex({ params, searchParams }: Props) {
  const data = await loadSite((await params).site);
  if (!data || storefrontHalted(data)) notFound();
  const { site } = data;
  const baseUrl = data.baseUrl.replace(/\/$/, "");
  const page = pageNumber((await searchParams).page);
  const { posts, pages } = await storefrontPosts(site.id, { page, withDrafts: data.preview });
  if (page > pages) notFound();

  await logTraffic({ siteId: site.id, path: "/blog", userAgent: (await headers()).get("user-agent") });

  const items = posts.map(renderPost);
  const jsonLd = blogStructuredData({
    name: `${site.name} blog`,
    url: `${baseUrl}/blog`,
    posts: items.filter((p) => p.status === "published").map((p) => ({ title: p.title, url: `${baseUrl}/blog/${p.handle}`, publishedAt: p.publishedAt! })),
  });

  return (
    <ThemeRoot themeId={site.themeId ?? "studio"} theme={data.theme} preview={data.preview}>
      <StoreTop data={data} />
      <main className="sf-main">
        <p className="sf-crumb">
          <a href={`${baseUrl}/`}>{site.name}</a> / Blog
        </p>
        <header className="sf-hero">
          <h1 className="sf-title">Blog</h1>
          {items.length === 0 ? <p className="sf-lede">No posts yet.</p> : null}
        </header>
        {items.length > 0 ? <PostList posts={items} baseUrl={baseUrl} /> : null}
        {pages > 1 ? (
          <nav className="sf-pager" aria-label="Blog pages">
            {page > 1 ? <a href={`${baseUrl}/blog${page === 2 ? "" : `?page=${page - 1}`}`} rel="prev">← Newer posts</a> : <span />}
            {page < pages ? <a href={`${baseUrl}/blog?page=${page + 1}`} rel="next">Older posts →</a> : <span />}
          </nav>
        ) : null}
      </main>
      <StoreFooter data={data} />
      <script
        type="application/ld+json"
        // Built by JSON.stringify from post fields; `<` escaped so a title cannot close the tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
    </ThemeRoot>
  );
}
