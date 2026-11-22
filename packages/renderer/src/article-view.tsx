import type { ReactNode } from "react";
import { parseArticle, type ArticleBlock } from "./article";
import type { Inline } from "./markdown";
import { resolveHref } from "./render";

/**
 * A blog post's body, drawn from its tree (`./article`). Every string goes
 * through React, so nothing in a post can become markup. The first image is the
 * page's likely LCP when the post has no cover, so it loads at once; the rest
 * are lazy (`docs/BUILDER.md` §13).
 */

function InlineView({ nodes, baseUrl }: { nodes: Inline[]; baseUrl: string }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={i} />;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return <strong key={i}><InlineView nodes={n.c} baseUrl={baseUrl} /></strong>;
      case "em":
        return <em key={i}><InlineView nodes={n.c} baseUrl={baseUrl} /></em>;
      case "link": {
        const href = resolveHref(n.href, baseUrl);
        return href ? <a key={i} href={href}><InlineView nodes={n.c} baseUrl={baseUrl} /></a> : <InlineView key={i} nodes={n.c} baseUrl={baseUrl} />;
      }
    }
  });
}

function Block({ b, baseUrl, lead }: { b: ArticleBlock; baseUrl: string; lead: boolean }): ReactNode {
  switch (b.type) {
    case "h2":
      return <h2><InlineView nodes={b.c} baseUrl={baseUrl} /></h2>;
    case "h3":
      return <h3><InlineView nodes={b.c} baseUrl={baseUrl} /></h3>;
    case "p":
      return <p><InlineView nodes={b.c} baseUrl={baseUrl} /></p>;
    case "quote":
      return <blockquote><p><InlineView nodes={b.c} baseUrl={baseUrl} /></p></blockquote>;
    case "ul":
      return <ul>{b.items.map((it, j) => <li key={j}><InlineView nodes={it} baseUrl={baseUrl} /></li>)}</ul>;
    case "ol":
      return <ol>{b.items.map((it, j) => <li key={j}><InlineView nodes={it} baseUrl={baseUrl} /></li>)}</ol>;
    case "img":
      return (
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={b.src} alt={b.alt} decoding="async" {...(lead ? { loading: "eager", fetchPriority: "high" } : { loading: "lazy" })} />
        </figure>
      );
    case "code":
      return <pre><code>{b.v}</code></pre>;
    case "hr":
      return <hr />;
  }
}

export function ArticleBody({ src, baseUrl, hasCover }: { src: string; baseUrl: string; hasCover: boolean }) {
  const blocks = parseArticle(src);
  const firstImage = hasCover ? -1 : blocks.findIndex((b) => b.type === "img");
  return (
    <div className="mk-article-body">
      {blocks.map((b, i) => (
        <Block key={i} b={b} baseUrl={baseUrl} lead={i === firstImage} />
      ))}
    </div>
  );
}

export type ArticleLdInput = {
  title: string;
  description: string;
  url: string;
  image?: string | null;
  author?: string;
  publishedAt: string;
  modifiedAt: string;
  store: { name: string; url: string };
};

/**
 * Schema.org `BlogPosting` — route-level like a product's `Product`, so no
 * design can remove it. The publisher is the store; the author is the byline
 * the merchant wrote, or the store when there is none.
 */
export function articleStructuredData(a: ArticleLdInput): object {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: a.title.slice(0, 110),
    description: a.description,
    url: a.url,
    mainEntityOfPage: a.url,
    ...(a.image ? { image: [a.image] } : {}),
    datePublished: a.publishedAt,
    dateModified: a.modifiedAt,
    author: a.author ? { "@type": "Person", name: a.author } : { "@type": "Organization", name: a.store.name, url: a.store.url },
    publisher: { "@type": "Organization", name: a.store.name, url: a.store.url },
  };
}

/** Schema.org `Blog` for the index, listing the posts on the page. */
export function blogStructuredData(b: {
  name: string;
  url: string;
  posts: { title: string; url: string; publishedAt: string }[];
}): object {
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: b.name,
    url: b.url,
    blogPost: b.posts.map((p) => ({ "@type": "BlogPosting", headline: p.title.slice(0, 110), url: p.url, datePublished: p.publishedAt })),
  };
}
