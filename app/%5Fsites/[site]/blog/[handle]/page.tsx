import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { StoreFooter, StoreTop } from "@/components/storefront/store-chrome";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { storefrontPost } from "@/lib/blog/queries";
import { descriptionOf, postStatus } from "@/lib/blog/rules";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { pageSocialMetadata } from "@/lib/storefront-meta";
import { redirectOrNotFound } from "@/lib/storefront/redirects";
import { ArticleBody, articleStructuredData } from "@markii/renderer/article-view";

type Props = { params: Promise<{ site: string; handle: string }> };

/**
 * `/blog/{handle}` — one post. Its title is the page's only `h1`; the body's
 * headings start at `h2` (`@markii/renderer/article`). `BlogPosting` JSON-LD is
 * route-level, like a product's `Product`. A post shoppers cannot see — a draft,
 * scheduled, or gone — answers as a missing page, through the store's redirects.
 */

function dateLabel(d: Date) {
  return d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data) return {};
  const post = await storefrontPost(data.site.id, handle, data.preview);
  if (!post) return {};
  const title = post.seo.title || `${post.title} — ${data.site.name}`;
  const description = descriptionOf(post) || undefined;
  const social = pageSocialMetadata(data, {
    title,
    description,
    path: `/blog/${post.handle}`,
    seo: { ...post.seo, ogImage: post.seo.ogImage ?? post.coverImage ?? undefined },
  });
  return {
    title,
    description,
    robots: data.site.indexed && !post.seo.noindex ? undefined : { index: false },
    ...social,
    openGraph: {
      ...social.openGraph,
      type: "article",
      ...(post.publishedAt ? { publishedTime: post.publishedAt.toISOString() } : {}),
      modifiedTime: post.updatedAt.toISOString(),
      ...(post.author ? { authors: [post.author] } : {}),
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data || storefrontHalted(data)) notFound();
  const { site } = data;
  const post = await storefrontPost(site.id, handle, data.preview);
  if (!post) return redirectOrNotFound(data, `/blog/${handle}`);

  await logTraffic({ siteId: site.id, path: `/blog/${post.handle}`, userAgent: (await headers()).get("user-agent") });

  const baseUrl = data.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/blog/${post.handle}`;
  const status = postStatus(post.publishedAt);
  const jsonLd =
    status === "published"
      ? articleStructuredData({
          title: post.title,
          description: descriptionOf(post),
          url,
          image: post.coverImage,
          author: post.author || undefined,
          publishedAt: post.publishedAt!.toISOString(),
          modifiedAt: post.updatedAt.toISOString(),
          store: { name: site.name, url: `${baseUrl}/` },
        })
      : null;

  return (
    <ThemeRoot themeId={site.themeId ?? "studio"} theme={data.theme} preview={data.preview}>
      <StoreTop data={data} />
      <main className="sf-main">
        <article className="sf-article">
          <p className="sf-crumb">
            <a href={`${baseUrl}/`}>{site.name}</a> / <a href={`${baseUrl}/blog`}>Blog</a>
          </p>
          <header className="sf-hero">
            <h1 className="sf-title">{post.title}</h1>
            <p className="sf-muted">
              {status === "draft" ? "Draft — not published" : status === "scheduled" ? `Scheduled for ${dateLabel(post.publishedAt!)}` : (
                <time dateTime={post.publishedAt!.toISOString()}>{dateLabel(post.publishedAt!)}</time>
              )}
              {post.author ? ` · ${post.author}` : null}
            </p>
          </header>
          {post.coverImage ? (
            <figure className="sf-article-cover">
              {/* The cover is this page's LCP: fetched at once (`docs/BUILDER.md` §13). */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={post.coverImage} alt={post.coverAlt} loading="eager" fetchPriority="high" decoding="async" />
            </figure>
          ) : null}
          <ArticleBody src={post.body} baseUrl={baseUrl} hasCover={Boolean(post.coverImage)} />
          <p className="sf-pager">
            <a href={`${baseUrl}/blog`}>← All posts</a>
          </p>
        </article>
      </main>
      <StoreFooter data={data} />
      {jsonLd ? (
        <script
          type="application/ld+json"
          // Built by JSON.stringify from post fields; `<` escaped so a title cannot close the tag.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      ) : null}
    </ThemeRoot>
  );
}
