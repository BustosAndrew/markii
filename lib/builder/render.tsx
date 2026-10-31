import type { ReactNode } from "react";
import { ProductCard } from "@/components/storefront/product-card";
import type { Category, Collection, Product } from "@/lib/db";
import { storefrontMembersOf } from "@/lib/storefront/collections";
import { markdownText, parseMarkdown, safeHref, type Inline } from "./markdown";
import { compileStyles, nodeClass } from "./styles";
import type { PageNode } from "./types";

/**
 * The builder's server renderer (`docs/BUILDER.md` §6): a node tree →
 * semantic HTML, as React server components.
 *
 * **One renderer for every consumer.** The storefront and the live preview
 * call the same `BuilderPage`, so what a merchant previews is what shoppers
 * get. Preview differs only in `ctx.preview`, which adds `data-mk-node` so the
 * editor can map a click back to a node; published output never carries it.
 *
 * Zero client JavaScript: accordions and FAQs are `<details>`, and every
 * string goes through React, which escapes it.
 */

export type RenderContext = {
  /** Where site-relative links point — the storefront, or the preview host in preview. */
  baseUrl: string;
  products: Product[];
  categories: Category[];
  /** Published collections only. */
  collections: Collection[];
  preview?: boolean;
};

/** Layout rules every builder page needs, independent of any one node. */
const BLOCK_CSS = [
  ".mk-page{display:block}",
  ".mk-b-section{display:block}",
  ".mk-b-section>*:last-child{margin-bottom:0}",
  ".mk-b-columns{display:grid;grid-template-columns:minmax(0,1fr)}",
  ...(["sm", "md", "lg"] as const).flatMap((bp) => {
    const px = { sm: 640, md: 768, lg: 1024 }[bp];
    return [2, 3, 4].map(
      (n) => `@media (min-width:${px}px){.mk-stack-${bp}.mk-cols-${n}{grid-template-columns:repeat(${n},minmax(0,1fr))}}`,
    );
  }),
  ".mk-b-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--mk-min,16rem),1fr))}",
  ".mk-grid-sm{--mk-min:12rem}.mk-grid-md{--mk-min:16rem}.mk-grid-lg{--mk-min:22rem}",
  ".mk-b-heading{font-family:var(--sf-font-display);line-height:1.15;letter-spacing:-0.02em;margin:0 0 .6em}",
  ".mk-b-text p{margin:0 0 1em}.mk-b-text p:last-child{margin-bottom:0}.mk-b-text a{text-decoration:underline;text-underline-offset:2px}",
  ".mk-b-text ul,.mk-b-text ol,.mk-b-list{margin:0 0 1em;padding-left:1.25em}",
  ".mk-b-image{margin:0}.mk-b-image img{display:block;width:100%;height:auto;border-radius:var(--sf-radius)}",
  ".mk-b-image figcaption{color:var(--sf-muted);font-size:.875rem;margin-top:.5rem}",
  ".mk-aspect-1-1 img{aspect-ratio:1/1;object-fit:cover}.mk-aspect-4-3 img{aspect-ratio:4/3;object-fit:cover}",
  ".mk-aspect-16-9 img{aspect-ratio:16/9;object-fit:cover}.mk-aspect-3-4 img{aspect-ratio:3/4;object-fit:cover}",
  ".mk-btn-secondary{background:transparent;color:var(--sf-fg);border:1px solid var(--sf-border)}",
  ".mk-btn-link{background:none;color:var(--sf-accent);padding:0;text-decoration:underline}",
  ".mk-b-details{border-top:1px solid var(--sf-border);padding:.75rem 0}.mk-b-details summary{cursor:pointer;font-weight:600}",
  ".mk-b-details>div{margin-top:.5rem}",
  ".mk-b-testimonial{margin:0}.mk-b-testimonial blockquote{margin:0 0 .5rem;font-size:1.15rem;font-family:var(--sf-font-display)}",
  ".mk-b-testimonial figcaption{color:var(--sf-muted)}",
  ".mk-b-video{position:relative;aspect-ratio:16/9}.mk-b-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}",
  ".mk-b-divider{border:0;border-top:1px solid var(--sf-border);margin:1.5rem 0}",
  ".mk-b-collections{list-style:none;padding:0;margin:0;display:grid;gap:1rem}",
  ".mk-space-0{height:0}.mk-space-xs{height:.25rem}.mk-space-sm{height:.5rem}.mk-space-md{height:1rem}",
  ".mk-space-lg{height:1.5rem}.mk-space-xl{height:2.5rem}.mk-space-2xl{height:4rem}.mk-space-3xl{height:6rem}",
].join("");

/** A site-relative link resolved against the storefront; absolute and fragment links pass through. */
export function resolveHref(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  const safe = safeHref(href);
  if (!safe) return null;
  return safe.startsWith("/") ? `${baseUrl.replace(/\/$/, "")}${safe}` : safe;
}

function attrs(node: PageNode, ctx: RenderContext, ...extra: (string | false | undefined)[]) {
  const className = [`mk-b-${node.type}`, nodeClass(node.id), ...extra].filter(Boolean).join(" ");
  return ctx.preview ? { className, "data-mk-node": node.id } : { className };
}

function InlineNodes({ nodes, ctx }: { nodes: Inline[]; ctx: RenderContext }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={i} />;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return <strong key={i}><InlineNodes nodes={n.c} ctx={ctx} /></strong>;
      case "em":
        return <em key={i}><InlineNodes nodes={n.c} ctx={ctx} /></em>;
      case "link": {
        const href = resolveHref(n.href, ctx.baseUrl);
        return href ? <a key={i} href={href}><InlineNodes nodes={n.c} ctx={ctx} /></a> : <InlineNodes key={i} nodes={n.c} ctx={ctx} />;
      }
    }
  });
}

function Markdown({ src, ctx }: { src: string; ctx: RenderContext }) {
  return parseMarkdown(src).map((b, i) =>
    b.type === "p" ? (
      <p key={i}><InlineNodes nodes={b.c} ctx={ctx} /></p>
    ) : b.type === "ul" ? (
      <ul key={i}>{b.items.map((item, j) => <li key={j}><InlineNodes nodes={item} ctx={ctx} /></li>)}</ul>
    ) : (
      <ol key={i}>{b.items.map((item, j) => <li key={j}><InlineNodes nodes={item} ctx={ctx} /></li>)}</ol>
    ),
  );
}

function videoEmbed(url: string): string | null {
  const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,20})/.exec(url);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vimeo = /vimeo\.com\/(\d{4,12})/.exec(url);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
}

function Children({ node, ctx }: { node: PageNode; ctx: RenderContext }) {
  return (node.children ?? []).map((child) => <Node key={child.id} node={child} ctx={ctx} />);
}

function ProductItems({ items, ctx, showPrice }: { items: Product[]; ctx: RenderContext; showPrice: boolean }) {
  return items.map((p) => (
    <ProductCard
      key={p.id}
      name={p.name}
      href={`${ctx.baseUrl.replace(/\/$/, "")}/p/${p.slug}`}
      priceCents={p.priceCents}
      currency={p.currency}
      stock={p.stock}
      imageUrl={p.images[0]}
      showPrice={showPrice}
    />
  ));
}

async function ProductGrid({ node, ctx }: { node: PageNode; ctx: RenderContext }) {
  const p = node.props as { source: string; categorySlug?: string; collectionHandle?: string; limit: number; showPrice: boolean };
  const enabled = ctx.products.filter((x) => x.enabled);
  let items: Product[] = [];
  if (p.source === "all") items = enabled;
  else if (p.source === "category") {
    const cat = ctx.categories.find((c) => c.slug === p.categorySlug);
    items = cat ? enabled.filter((x) => x.categoryId === cat.id) : [];
  } else {
    const coll = ctx.collections.find((c) => c.handle === p.collectionHandle);
    items = coll ? (await storefrontMembersOf(coll, p.limit)).filter((x) => x.enabled) : [];
  }
  return (
    <ul {...attrs(node, ctx, "sf-grid")}>
      <ProductItems items={items.slice(0, p.limit)} ctx={ctx} showPrice={p.showPrice} />
    </ul>
  );
}

function Node({ node, ctx }: { node: PageNode; ctx: RenderContext }): ReactNode {
  const p = node.props as Record<string, unknown>;
  switch (node.type) {
    case "root":
      return <Children node={node} ctx={ctx} />;
    case "section":
      return (
        <section {...attrs(node, ctx)} aria-label={(p.label as string) || undefined}>
          <Children node={node} ctx={ctx} />
        </section>
      );
    case "columns": {
      const n = Math.max(1, Math.min(4, node.children?.length ?? 1));
      return (
        <div {...attrs(node, ctx, `mk-cols-${n}`, `mk-stack-${p.stackBelow ?? "md"}`)}>
          <Children node={node} ctx={ctx} />
        </div>
      );
    }
    case "column":
      return <div {...attrs(node, ctx)}><Children node={node} ctx={ctx} /></div>;
    case "grid":
      return <div {...attrs(node, ctx, `mk-grid-${p.minItemWidth ?? "md"}`)}><Children node={node} ctx={ctx} /></div>;
    case "spacer":
      return <div {...attrs(node, ctx, `mk-space-${p.size ?? "lg"}`)} aria-hidden="true" />;
    case "divider":
      return <hr {...attrs(node, ctx)} />;
    case "heading": {
      const level = Math.max(1, Math.min(6, Number(p.level ?? 2)));
      const Tag = `h${level}` as "h1";
      return <Tag {...attrs(node, ctx, level === 1 && "sf-title")}>{String(p.text ?? "")}</Tag>;
    }
    case "text":
      return <div {...attrs(node, ctx)}><Markdown src={String(p.markdown ?? "")} ctx={ctx} /></div>;
    case "image": {
      if (!p.src) return ctx.preview ? <div {...attrs(node, ctx)} data-mk-empty="image" /> : null;
      const aspect = p.aspect && p.aspect !== "auto" ? `mk-aspect-${String(p.aspect).replace("/", "-")}` : undefined;
      // eslint-disable-next-line @next/next/no-img-element
      const img = <img src={String(p.src)} alt={p.decorative ? "" : String(p.alt ?? "")} loading="lazy" decoding="async" />;
      const href = resolveHref(p.href as string | undefined, ctx.baseUrl);
      return (
        <figure {...attrs(node, ctx, aspect)}>
          {href ? <a href={href}>{img}</a> : img}
          {p.caption ? <figcaption>{String(p.caption)}</figcaption> : null}
        </figure>
      );
    }
    case "button": {
      const href = resolveHref(p.href as string, ctx.baseUrl) ?? "#";
      return (
        <a {...attrs(node, ctx, p.variant === "link" ? "mk-btn-link" : "sf-btn", p.variant === "secondary" && "mk-btn-secondary")} href={href}>
          {String(p.label ?? "")}
        </a>
      );
    }
    case "list": {
      const items = (p.items as string[]) ?? [];
      const Tag = p.ordered ? "ol" : "ul";
      return <Tag {...attrs(node, ctx)}>{items.map((item, i) => <li key={i}>{item}</li>)}</Tag>;
    }
    case "accordion":
      return (
        <div {...attrs(node, ctx)}>
          {((p.items as { title: string; body: string }[]) ?? []).map((item, i) => (
            <details key={i} className="mk-b-details">
              <summary>{item.title}</summary>
              <div className="mk-b-text"><Markdown src={item.body} ctx={ctx} /></div>
            </details>
          ))}
        </div>
      );
    case "faq":
      return (
        <div {...attrs(node, ctx)}>
          {((p.items as { question: string; answer: string }[]) ?? []).map((item, i) => (
            <details key={i} className="mk-b-details">
              <summary>{item.question}</summary>
              <div className="mk-b-text"><Markdown src={item.answer} ctx={ctx} /></div>
            </details>
          ))}
        </div>
      );
    case "testimonial":
      return (
        <figure {...attrs(node, ctx)}>
          <blockquote><p>{String(p.quote ?? "")}</p></blockquote>
          <figcaption>
            — {String(p.author ?? "")}
            {p.role ? `, ${String(p.role)}` : ""}
          </figcaption>
        </figure>
      );
    case "video": {
      const src = p.url ? videoEmbed(String(p.url)) : null;
      if (!src) return ctx.preview ? <div {...attrs(node, ctx)} data-mk-empty="video" /> : null;
      return (
        <div {...attrs(node, ctx)}>
          <iframe src={src} title={String(p.title ?? "Video")} loading="lazy" allow="encrypted-media; picture-in-picture" allowFullScreen />
        </div>
      );
    }
    case "productGrid":
      return <ProductGrid node={node} ctx={ctx} />;
    case "productCard": {
      const product = ctx.products.find((x) => x.enabled && x.slug === p.productSlug);
      if (!product) return ctx.preview ? <div {...attrs(node, ctx)} data-mk-empty="product" /> : null;
      return (
        <ul {...attrs(node, ctx, "sf-grid")}>
          <ProductItems items={[product]} ctx={ctx} showPrice />
        </ul>
      );
    }
    case "collectionList": {
      const items = ctx.collections.slice(0, Number(p.limit ?? 6));
      return (
        <ul {...attrs(node, ctx)}>
          {items.map((c) => (
            <li key={c.id}>
              <a href={`${ctx.baseUrl.replace(/\/$/, "")}/collections/${c.handle}`}><strong>{c.title}</strong></a>
              {p.showDescriptions && c.description ? <p className="sf-muted">{c.description}</p> : null}
            </li>
          ))}
        </ul>
      );
    }
    default:
      // Unknown types cannot be stored (validateTree refuses them); this only guards a stale renderer.
      return null;
  }
}

/** Structured data the page's blocks contribute, merged into one JSON-LD script. */
export function pageJsonLd(tree: PageNode): object[] {
  const faqs: { question: string; answer: string }[] = [];
  const walk = (n: PageNode) => {
    if (n.type === "faq") faqs.push(...((n.props.items as { question: string; answer: string }[]) ?? []));
    (n.children ?? []).forEach(walk);
  };
  walk(tree);
  if (faqs.length === 0) return [];
  return [
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: markdownText(f.answer) },
      })),
    },
  ];
}

/** Types the renderer handles — a unit test holds this equal to the registry. */
export const RENDERED_TYPES = [
  "root", "section", "columns", "column", "grid", "spacer", "divider", "heading", "text", "image",
  "button", "list", "accordion", "faq", "testimonial", "video", "productGrid", "productCard", "collectionList",
] as const;

/**
 * A whole builder page: its compiled styles, its blocks, its structured data.
 * The JSON-LD string is built by `JSON.stringify` and only ever contains data
 * — `<` is escaped so a merchant's FAQ text cannot close the script tag.
 */
export function BuilderPage({ tree, ctx }: { tree: PageNode; ctx: RenderContext }) {
  const jsonLd = pageJsonLd(tree);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: BLOCK_CSS + compileStyles(tree) }} />
      <main className="mk-page" {...(ctx.preview ? { "data-mk-node": tree.id } : {})}>
        <Node node={tree} ctx={ctx} />
      </main>
      {jsonLd.length > 0 ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd.length === 1 ? jsonLd[0] : jsonLd).replace(/</g, "\\u003c") }}
        />
      ) : null}
    </>
  );
}
