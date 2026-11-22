import type { ReactNode } from "react";
import type { RenderForm } from "./forms";
import { FormView } from "./forms-view";
import type { MembersOf, RenderCategory as Category, RenderCollection as Collection, RenderProduct as Product } from "./catalog";
import { REPEATER_SOURCES, boundProps, evaluateCondition, type DataValues, type RepeaterSource } from "./bindings";
import { markdownText, parseMarkdown, safeHref, type Inline } from "./markdown";
import { ProductCard } from "./product-card";
import { sanitizeHtml } from "./sanitize";
import { compileStyles, nodeClass } from "./styles";
import type { PageNode, RegionHandle } from "./types";
import { productView } from "./views";

/**
 * The builder's server renderer (`docs/BUILDER.md` §6): a node tree →
 * semantic HTML, as React server components.
 *
 * **One renderer for every consumer.** The storefront and the live preview
 * call the same `BuilderPage`, so what a merchant previews is what shoppers
 * get. Preview differs only in `ctx.preview`, which adds `data-mk-node` so the
 * editor can map a click back to a node; published output never carries it.
 *
 * Zero client JavaScript of its own: accordions and FAQs are `<details>`, and
 * every string goes through React, which escapes it. The one island is the
 * Buy block's Add to cart, the same sanctioned island the fixed product page
 * has always used — and the caller renders it (`ProductPurchase.buy`), so the
 * drawing code never imports the cart.
 *
 * **The drawing code, and nothing else (D53).** This module and the ones it
 * imports are what a store's Next.js export ships, under Apache 2.0 once split
 * out. Everything outside drawing arrives through the context: the catalogue as
 * the renderer's own shapes (`./catalog`), collection lookups as `membersOf`,
 * the cart as a rendered element. `lib/builder/renderer-boundary.test.ts`
 * refuses an import that crosses the line.
 *
 * **Data comes from `ctx.values`** (M4): bindings fill props from it and
 * conditions read it. The block CSS these classes rely on is emitted once per
 * page by `ThemeRoot` (`./block-css`); each document here adds only its own
 * compiled node styles.
 */

/** What the product template's Buy block needs — everything the fixed product page computes. */
export type ProductPurchase = {
  /** The Add to cart island, rendered by the caller — the drawing code does not know how a cart works. */
  buy: ReactNode;
  gate: { tierName: string; unlocked: boolean } | null;
  /** The x402 checkout request an agent would send, or null when this product cannot be bought that way here. */
  agentCheckout: { request: string; agentMdHref: string } | null;
};

export type RenderContext = {
  /** Where site-relative links point — the storefront, or the preview host in preview. */
  baseUrl: string;
  products: Product[];
  categories: Category[];
  /** Published collections only. */
  collections: Collection[];
  /** A collection's products, for a grid showing one collection (`./catalog`). */
  membersOf: MembersOf;
  preview?: boolean;
  /** The data bindings and conditions read. `store` always; `product` / `collection` on their templates; `item` inside a repeater. */
  values: DataValues;
  /** The page's own product, on the product template. */
  product?: { record: Product; purchase: ProductPurchase };
  /** The page's collection's products, in order, on the collection template. */
  collectionProducts?: Product[];
  /** Set while rendering a global region: sections render as plain groups, the region is the landmark. */
  region?: RegionHandle;
  /** The current search, so a header search box on the results page shows what was searched. */
  searchQuery?: string;
  /** A page's own `WebPage` JSON-LD (M5). Absent on templates, whose routes emit Product / CollectionPage. */
  page?: PageLd;
  /**
   * The cart or account page (M6): no custom HTML renders, even in the header
   * and footer — shoppers type passwords and card details here, and code the
   * merchant pasted from somewhere has no business beside them.
   */
  sensitive?: boolean;
  /**
   * The document being drawn. In the preview it is stamped as `data-mk-doc`, so
   * a click on the header while the editor has the home page open can switch
   * the editor to the header.
   */
  documentId?: number;
  /**
   * The page's likely largest above-the-fold image (`docs/BUILDER.md` §13,
   * LCP): loaded eagerly at high priority, while every other image stays lazy.
   * Set by `BuilderPage` from `leadImageId`; never inside a region, whose logo
   * is small and on every page.
   */
  leadImageId?: string;
  /**
   * A store form by handle, for the `form` block — looked up only when a page
   * has one, like `membersOf`. Absent (an export with no form API), the block
   * draws nothing outside the preview.
   */
  formOf?: (handle: string) => Promise<RenderForm | null>;
};

const LEAD_IMAGE_TYPES = new Set(["image", "productGallery"]);

/**
 * The image a page leads with: the first `image` or `productGallery` block, in
 * document order, inside the page's first top-level block — roughly what is
 * above the fold. A lazy-loaded hero is the page's LCP waiting for layout, so
 * this one loads at once; an image further down is not promoted, because a
 * high-priority fetch below the fold competes with what the shopper sees first.
 */
export function leadImageId(tree: PageNode): string | undefined {
  const first = tree.children?.[0];
  if (!first) return undefined;
  const walk = (node: PageNode): string | undefined => {
    if (LEAD_IMAGE_TYPES.has(node.type)) return node.id;
    for (const child of node.children ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(first);
}

/** Loading hints for an image: eager and high priority for the page's lead image, lazy for the rest. */
function imageLoading(lead: boolean) {
  return lead ? ({ loading: "eager", fetchPriority: "high" } as const) : ({ loading: "lazy" } as const);
}

/** A site-relative link resolved against the storefront; absolute and fragment links pass through. */
export function resolveHref(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  const safe = safeHref(href);
  if (!safe) return null;
  return safe.startsWith("/") ? `${baseUrl.replace(/\/$/, "")}${safe}` : safe;
}

function base(ctx: RenderContext) {
  return ctx.baseUrl.replace(/\/$/, "");
}

function attrs(node: PageNode, ctx: RenderContext, ...extra: (string | false | undefined)[]) {
  // The merchant's own classes last (M6) — validated tokens, never mk- or sf-.
  const className = [`mk-b-${node.type}`, nodeClass(node.id), ...extra, node.customClass].filter(Boolean).join(" ");
  return ctx.preview ? { className, "data-mk-node": node.id } : { className };
}

/** Something the preview shows so the merchant can reach a block that has nothing to draw yet. */
function Empty({ node, ctx, what }: { node: PageNode; ctx: RenderContext; what: string }) {
  return ctx.preview ? <div {...attrs(node, ctx)} data-mk-empty={what} /> : null;
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

async function FormBlock({ node, ctx, p }: { node: PageNode; ctx: RenderContext; p: Record<string, unknown> }) {
  const handle = typeof p.formHandle === "string" ? p.formHandle : "";
  const form = handle && ctx.formOf ? await ctx.formOf(handle) : null;
  if (!form) return <Empty node={node} ctx={ctx} what={handle ? `form "${handle}" — not found in this store` : "form — choose one"} />;
  const root = base(ctx);
  const here = ctx.page?.url?.startsWith(root) ? ctx.page.url.slice(root.length) || "/" : undefined;
  const a = attrs(node, ctx);
  const marker = "data-mk-node" in a && a["data-mk-node"] ? { "data-mk-node": a["data-mk-node"] } : undefined;
  return <FormView form={form} action={`${root}/api/forms/${form.handle}`} className={a.className} attrs={marker} returnPath={here} />;
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
      href={`${base(ctx)}/p/${p.slug}`}
      priceCents={p.priceCents}
      currency={p.currency}
      stock={p.stock}
      imageUrl={p.images[0]}
      showPrice={showPrice}
    />
  ));
}

async function ProductGrid({ node, ctx, p }: { node: PageNode; ctx: RenderContext; p: Record<string, unknown> }) {
  const props = p as { source: string; categorySlug?: string; collectionHandle?: string; limit: number; showPrice: boolean };
  const enabled = ctx.products.filter((x) => x.enabled);
  let items: Product[] = [];
  if (props.source === "all") items = enabled;
  else if (props.source === "category") {
    const cat = ctx.categories.find((c) => c.slug === props.categorySlug);
    items = cat ? enabled.filter((x) => x.categoryId === cat.id) : [];
  } else if (props.source === "current") {
    if (!ctx.collectionProducts) return <Empty node={node} ctx={ctx} what="collection — shown on collection pages" />;
    items = ctx.collectionProducts;
  } else {
    const coll = ctx.collections.find((c) => c.handle === props.collectionHandle);
    items = coll ? (await ctx.membersOf(coll.handle, props.limit)).filter((x) => x.enabled) : [];
  }
  return (
    <ul {...attrs(node, ctx, "sf-grid")}>
      <ProductItems items={items.slice(0, props.limit)} ctx={ctx} showPrice={props.showPrice} />
    </ul>
  );
}

/** A repeater's items, or null when its source does not exist on this document. */
function repeaterItems(source: RepeaterSource, ctx: RenderContext): Product[] | null {
  switch (source) {
    case "store.products":
      return ctx.products.filter((x) => x.enabled);
    case "collection.products":
      return ctx.collectionProducts ?? null;
    case "product.related": {
      if (!ctx.product) return null;
      const byId = new Map(ctx.products.filter((x) => x.enabled).map((x) => [x.id, x]));
      return ctx.product.record.suggestedProductIds.map((id) => byId.get(id)).filter((x): x is Product => Boolean(x));
    }
  }
}

function Repeater({ node, ctx, p }: { node: PageNode; ctx: RenderContext; p: Record<string, unknown> }) {
  const source = p.source as RepeaterSource;
  const items = repeaterItems(source, ctx);
  if (items === null) return <Empty node={node} ctx={ctx} what={`${REPEATER_SOURCES[source]?.label.toLowerCase() ?? "items"}`} />;
  const shown = items.slice(0, Number(p.limit ?? 12));
  if (shown.length === 0) {
    return p.emptyText ? <p {...attrs(node, ctx, "sf-muted")}>{String(p.emptyText)}</p> : <Empty node={node} ctx={ctx} what="products — none to show" />;
  }
  return (
    <ul {...attrs(node, ctx, `mk-grid-${p.minItemWidth ?? "md"}`)}>
      {shown.map((item) => {
        const itemCtx: RenderContext = {
          ...ctx,
          values: { ...ctx.values, item: productView(item, { baseUrl: ctx.baseUrl, categories: ctx.categories, products: ctx.products }) },
        };
        return (
          <li key={item.id}>
            <Children node={node} ctx={itemCtx} />
          </li>
        );
      })}
    </ul>
  );
}

function ProductBuy({ node, ctx, p }: { node: PageNode; ctx: RenderContext; p: Record<string, unknown> }) {
  if (!ctx.product) return <Empty node={node} ctx={ctx} what="buy buttons — shown on product pages" />;
  const { purchase } = ctx.product;
  const locked = purchase.gate !== null && !purchase.gate.unlocked;
  return (
    <div {...attrs(node, ctx)}>
      {purchase.gate ? (
        <p className={locked ? "sf-gate sf-gate-locked" : "sf-gate"}>
          {locked ? (
            <>
              <strong>Members only.</strong> This product is available to {purchase.gate.tierName} members.{" "}
              <a href={`${base(ctx)}/account`}>Sign in or create an account</a> to check whether your membership covers it.
            </>
          ) : (
            <strong>Included with your {purchase.gate.tierName} membership.</strong>
          )}
        </p>
      ) : null}
      {purchase.buy}
      {p.showAgentCheckout !== false && purchase.agentCheckout && !locked ? (
        <>
          <h2>Buy via agent</h2>
          <pre className="sf-buy">{purchase.agentCheckout.request}</pre>
          <p className="sf-muted">
            Payment protocol: <a href={purchase.agentCheckout.agentMdHref}>agent.md</a> (x402 / USDC)
          </p>
        </>
      ) : null}
    </div>
  );
}

function NavMenu({ node, ctx, p }: { node: PageNode; ctx: RenderContext; p: Record<string, unknown> }) {
  const links: { label: string; href: string }[] = [];
  for (const item of (p.items as { label: string; href: string }[]) ?? []) {
    const href = resolveHref(item.href, ctx.baseUrl);
    if (href) links.push({ label: item.label, href });
  }
  if (p.categories) {
    for (const c of ctx.categories.filter((c) => c.parentId == null)) links.push({ label: c.name, href: `${base(ctx)}/c/${c.slug}` });
  }
  if (p.collections && ctx.collections.length > 0) links.push({ label: "Collections", href: `${base(ctx)}/collections` });
  if (links.length === 0) return <Empty node={node} ctx={ctx} what="menu links" />;
  return (
    <nav {...attrs(node, ctx, "sf-nav", p.direction === "column" && "mk-menu-column")} aria-label={String(p.label ?? "Menu")}>
      {links.map((l, i) => (
        <a key={`${l.href}-${i}`} href={l.href}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}

function Node({ node, ctx }: { node: PageNode; ctx: RenderContext }): ReactNode {
  if (node.visibleWhen) {
    const shown = evaluateCondition(node.visibleWhen, ctx.values);
    // Unanswerable here (no product on this page): hidden from shoppers, kept reachable in the preview.
    if (shown === false || (shown === null && !ctx.preview)) return null;
  }
  const p = boundProps(node, ctx.values);
  switch (node.type) {
    case "root":
      return <Children node={node} ctx={ctx} />;
    case "section":
      // In a header or footer the region is the landmark; a <section> per band would add unnamed regions.
      return ctx.region ? (
        <div {...attrs(node, ctx)}>
          <Children node={node} ctx={ctx} />
        </div>
      ) : (
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
    case "row":
      return (
        <div {...attrs(node, ctx, `mk-justify-${p.justify ?? "between"}`, p.wrap === false && "mk-nowrap")}>
          <Children node={node} ctx={ctx} />
        </div>
      );
    case "repeater":
      return <Repeater node={node} ctx={ctx} p={p} />;
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
      if (!p.src) return <Empty node={node} ctx={ctx} what="image" />;
      const aspect = p.aspect && p.aspect !== "auto" ? `mk-aspect-${String(p.aspect).replace("/", "-")}` : undefined;
      const img = (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={String(p.src)}
          alt={p.decorative ? "" : String(p.alt ?? "")}
          {...imageLoading(node.id === ctx.leadImageId)}
          decoding="async"
        />
      );
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
      if (!src) return <Empty node={node} ctx={ctx} what="video" />;
      return (
        <div {...attrs(node, ctx)}>
          <iframe src={src} title={String(p.title ?? "Video")} loading="lazy" allow="encrypted-media; picture-in-picture" allowFullScreen />
        </div>
      );
    }
    case "productGrid":
      return <ProductGrid node={node} ctx={ctx} p={p} />;
    case "productCard": {
      const product = ctx.products.find((x) => x.enabled && x.slug === p.productSlug);
      if (!product) return <Empty node={node} ctx={ctx} what="product" />;
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
              <a href={`${base(ctx)}/collections/${c.handle}`}><strong>{c.title}</strong></a>
              {p.showDescriptions && c.description ? <p className="sf-muted">{c.description}</p> : null}
            </li>
          ))}
        </ul>
      );
    }
    case "productBuy":
      return <ProductBuy node={node} ctx={ctx} p={p} />;
    case "productGallery": {
      if (!ctx.product) return <Empty node={node} ctx={ctx} what="product images — shown on product pages" />;
      const { record } = ctx.product;
      if (record.images.length === 0) return <Empty node={node} ctx={ctx} what="product images — this product has none" />;
      return (
        <figure {...attrs(node, ctx, p.layout === "grid" && "mk-gallery-grid")}>
          {record.images.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={src} src={src} alt={record.name} {...imageLoading(i === 0 && node.id === ctx.leadImageId)} decoding="async" />
          ))}
        </figure>
      );
    }
    case "navMenu":
      return <NavMenu node={node} ctx={ctx} p={p} />;
    case "storeBrand":
      return (
        <a {...attrs(node, ctx, "sf-brand")} href={`${base(ctx)}/`}>
          {p.logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={String(p.logoSrc)} alt={p.showName === false ? String(p.logoAlt || ctx.values.store.name) : String(p.logoAlt ?? "")} />
          ) : null}
          {p.showName !== false || !p.logoSrc ? ctx.values.store.name : null}
        </a>
      );
    case "form":
      return <FormBlock node={node} ctx={ctx} p={p} />;
    case "html": {
      if (ctx.sensitive) return ctx.preview ? <div {...attrs(node, ctx)} data-mk-empty="custom HTML — hidden on cart and account pages" /> : null;
      // Cleaned again on the way out: a stricter rule made later also covers HTML saved before it.
      const html = sanitizeHtml(String(p.html ?? ""));
      if (!html) return <Empty node={node} ctx={ctx} what="custom HTML" />;
      return <div {...attrs(node, ctx)} dangerouslySetInnerHTML={{ __html: html }} />;
    }
    case "storeLinks":
      return (
        <div {...attrs(node, ctx, "sf-header-actions")}>
          {p.search !== false ? (
            <form className="sf-search" role="search" action={`${base(ctx)}/search`} method="get">
              <input type="search" name="q" defaultValue={ctx.searchQuery ?? ""} placeholder="Search products" aria-label="Search products" maxLength={200} />
              <button type="submit">Search</button>
            </form>
          ) : null}
          {p.account !== false ? <a className="sf-cart-link" href={`${base(ctx)}/account`}>Account</a> : null}
          {p.cart !== false ? <a className="sf-cart-link" href={`${base(ctx)}/cart`}>Cart</a> : null}
        </div>
      );
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

/** What a page's `WebPage` JSON-LD says about it (M5). Set for pages, not templates — their routes describe them. */
export type PageLd = { name: string; description?: string; url: string };

/** A block hidden from shoppers here contributes no structured data either — the same rule as rendering, live. */
function visibleTo(node: PageNode, ctx: RenderContext): boolean {
  return !node.visibleWhen || evaluateCondition(node.visibleWhen, ctx.values) === true;
}

function itemList(items: Product[], ctx: RenderContext, name?: string) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    ...(name ? { name } : {}),
    numberOfItems: items.length,
    itemListElement: items.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${base(ctx)}/p/${p.slug}`, name: p.name })),
  };
}

/**
 * Everything a builder document contributes to the page's one JSON-LD script
 * (`docs/BUILDER.md` §6 — "commerce blocks must implement jsonLd"): `WebPage`
 * for a page, `FAQPage` from its FAQs, and an `ItemList` for each product
 * listing a shopper can see — grids, featured products, repeaters.
 *
 * Listings of the collection a template shows are left to the route, whose
 * `CollectionPage` already carries that list; a second copy would be noise.
 */
export async function documentJsonLd(tree: PageNode, ctx: RenderContext): Promise<object[]> {
  const out: object[] = [];
  if (ctx.page) {
    out.push({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: ctx.page.name,
      ...(ctx.page.description ? { description: ctx.page.description } : {}),
      url: ctx.page.url,
      isPartOf: { "@type": "WebSite", name: ctx.values.store.name, url: ctx.values.store.url },
    });
  }
  const faqs: { question: string; answer: string }[] = [];
  const lists: Promise<object | null>[] = [];
  const enabled = ctx.products.filter((x) => x.enabled);

  const walk = (n: PageNode) => {
    if (!visibleTo(n, ctx)) return;
    const p = boundProps(n, ctx.values);
    switch (n.type) {
      case "faq":
        faqs.push(...((p.items as { question: string; answer: string }[]) ?? []));
        break;
      case "productGrid": {
        const limit = Number(p.limit ?? 12);
        if (p.source === "all") lists.push(Promise.resolve(itemList(enabled.slice(0, limit), ctx)));
        else if (p.source === "category") {
          const cat = ctx.categories.find((c) => c.slug === p.categorySlug);
          if (cat) lists.push(Promise.resolve(itemList(enabled.filter((x) => x.categoryId === cat.id).slice(0, limit), ctx, cat.name)));
        } else if (p.source === "collection") {
          const coll = ctx.collections.find((c) => c.handle === p.collectionHandle);
          if (coll) lists.push(ctx.membersOf(coll.handle, limit).then((m) => itemList(m.filter((x) => x.enabled).slice(0, limit), ctx, coll.title)));
        }
        break;
      }
      case "productCard": {
        const product = enabled.find((x) => x.slug === p.productSlug);
        if (product) lists.push(Promise.resolve(itemList([product], ctx)));
        break;
      }
      case "repeater": {
        const source = p.source as RepeaterSource;
        if (source === "collection.products") break;
        const items = repeaterItems(source, ctx);
        if (items?.length) lists.push(Promise.resolve(itemList(items.slice(0, Number(p.limit ?? 12)), ctx)));
        return; // its children are the per-item design, not more listings
      }
    }
    (n.children ?? []).forEach(walk);
  };
  walk(tree);

  if (faqs.length) {
    out.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: markdownText(f.answer) },
      })),
    });
  }
  for (const list of await Promise.all(lists)) {
    if (list && (list as { numberOfItems: number }).numberOfItems > 0) out.push(list);
  }
  return out;
}

/** Types the renderer handles — a unit test holds this equal to the registry. */
export const RENDERED_TYPES = [
  "root", "section", "columns", "column", "grid", "row", "repeater", "spacer", "divider", "heading", "text",
  "image", "button", "list", "accordion", "faq", "testimonial", "video", "productGrid", "productCard",
  "collectionList", "productBuy", "productGallery", "navMenu", "storeBrand", "storeLinks", "html", "form",
] as const;

function docAttr(ctx: RenderContext) {
  return ctx.preview && ctx.documentId !== undefined ? { "data-mk-doc": String(ctx.documentId) } : {};
}

/**
 * A whole builder page: its compiled styles, its blocks, its structured data.
 * The JSON-LD string is built by `JSON.stringify` and only ever contains data
 * — `<` is escaped so a merchant's FAQ text cannot close the script tag.
 */
export async function BuilderPage({ tree, ctx: outer }: { tree: PageNode; ctx: RenderContext }) {
  const ctx: RenderContext = { ...outer, leadImageId: leadImageId(tree) };
  const jsonLd = await documentJsonLd(tree, ctx);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: compileStyles(tree) }} />
      <main className="mk-page" {...(ctx.preview ? { "data-mk-node": tree.id } : {})} {...docAttr(ctx)}>
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

/**
 * A global region (M4). The header renders inside the theme's own header
 * frame (`sf-header` / `sf-header-inner`), so a customised header keeps each
 * theme's look; the footer is the page's `<footer>` landmark; the
 * announcement bar is a named region above everything.
 */
export function BuilderRegion({ region, tree, ctx }: { region: RegionHandle; tree: PageNode; ctx: RenderContext }) {
  const regionCtx: RenderContext = { ...ctx, region };
  const body = <Node node={tree} ctx={regionCtx} />;
  const marker = { ...(ctx.preview ? { "data-mk-node": tree.id } : {}), ...docAttr(ctx) };
  const css = <style dangerouslySetInnerHTML={{ __html: compileStyles(tree) }} />;
  if (region === "header") {
    return (
      <>
        {css}
        <header className="sf-header mk-region-header" {...marker}>
          <div className="sf-header-inner">{body}</div>
        </header>
      </>
    );
  }
  if (region === "footer") {
    return (
      <>
        {css}
        <footer className="mk-region-footer" {...marker}>
          {body}
        </footer>
      </>
    );
  }
  return (
    <>
      {css}
      <div className="mk-region-announcement" role="region" aria-label="Announcement" {...marker}>
        {body}
      </div>
    </>
  );
}
