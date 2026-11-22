import type { MembersOf, RenderCategory as Category, RenderCollection as Collection, RenderProduct as Product } from "./catalog";
import { formatPrice } from "./format";
import { REPEATER_SOURCES, boundProps, evaluateCondition, type DataValues, type RepeaterSource } from "./bindings";
import { parseMarkdown, safeHref, type Inline } from "./markdown";
import type { PageNode } from "./types";

/**
 * A published page as Markdown (M5) — what `llms-full.txt` serves, so an agent
 * reads a store's own pages (its returns policy, its About, its FAQ) as clean
 * text instead of scraping HTML.
 *
 * **The HTML renderer's semantics, restated for text** (`./render`): the same
 * bindings and visibility conditions, the same catalogue reads, links resolved
 * against the storefront. A block hidden from shoppers is absent here too —
 * including one whose condition cannot be answered on a page, as live.
 *
 * Product listings — grids, featured products, repeaters — come out as one
 * list of links with price and stock, whatever cards they were drawn with:
 * that is what a listing *means* to an agent, and a repeater's per-item blocks
 * would otherwise repeat the same layout once per product.
 *
 * Headings are demoted by `headingOffset`, so a page's `h1` can sit under the
 * document's own title.
 */

export type MarkdownContext = {
  baseUrl: string;
  products: Product[];
  categories: Category[];
  /** Published collections only. */
  collections: Collection[];
  values: DataValues;
  /** A collection's storefront members, for a grid showing one. */
  membersOf: MembersOf;
  headingOffset?: number;
};

function base(ctx: MarkdownContext) {
  return ctx.baseUrl.replace(/\/$/, "");
}

function href(raw: string | undefined, ctx: MarkdownContext): string | null {
  if (!raw) return null;
  const safe = safeHref(raw);
  if (!safe) return null;
  return safe.startsWith("/") ? `${base(ctx)}${safe}` : safe;
}

/** One line of plain text — a heading or list item may not break the document's structure. */
function line(s: unknown): string {
  return String(s ?? "").replace(/\s*\n\s*/g, " ").trim();
}

function inline(nodes: Inline[], ctx: MarkdownContext): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return n.v;
        case "br":
          return "  \n";
        case "code":
          return `\`${n.v}\``;
        case "strong":
          return `**${inline(n.c, ctx)}**`;
        case "em":
          return `*${inline(n.c, ctx)}*`;
        case "link": {
          const target = href(n.href, ctx);
          return target ? `[${inline(n.c, ctx)}](${target})` : inline(n.c, ctx);
        }
      }
    })
    .join("");
}

/** Text-block Markdown, re-serialised from its parsed tree — relative links become absolute, unsafe ones text. */
function markdown(src: string, ctx: MarkdownContext): string {
  return parseMarkdown(src)
    .map((b) =>
      b.type === "p"
        ? inline(b.c, ctx)
        : b.items.map((item, i) => `${b.type === "ol" ? `${i + 1}.` : "-"} ${inline(item, ctx)}`).join("\n"),
    )
    .join("\n\n");
}

function productLines(items: Product[], ctx: MarkdownContext, showPrice = true): string {
  return items
    .map((p) => {
      const price = showPrice ? ` — ${formatPrice(p.priceCents, p.currency)}` : "";
      return `- [${line(p.name)}](${base(ctx)}/p/${p.slug})${price}${p.stock > 0 ? "" : " (out of stock)"}`;
    })
    .join("\n");
}

async function block(node: PageNode, ctx: MarkdownContext): Promise<string[]> {
  if (node.visibleWhen && evaluateCondition(node.visibleWhen, ctx.values) !== true) return [];
  const p = boundProps(node, ctx.values);
  const children = async () => (await Promise.all((node.children ?? []).map((c) => block(c, ctx)))).flat();
  const enabled = () => ctx.products.filter((x) => x.enabled);

  switch (node.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(p.level ?? 2)) + (ctx.headingOffset ?? 0));
      return [`${"#".repeat(level)} ${line(p.text)}`];
    }
    case "text": {
      const md = markdown(String(p.markdown ?? ""), ctx);
      return md ? [md] : [];
    }
    case "list": {
      const items = ((p.items as string[]) ?? []).map((item, i) => `${p.ordered ? `${i + 1}.` : "-"} ${line(item)}`);
      return items.length ? [items.join("\n")] : [];
    }
    case "accordion":
      return ((p.items as { title: string; body: string }[]) ?? []).flatMap((i) => [`**${line(i.title)}**`, markdown(i.body, ctx)]);
    case "faq":
      return ((p.items as { question: string; answer: string }[]) ?? []).flatMap((i) => [`**Q: ${line(i.question)}**`, markdown(i.answer, ctx)]);
    case "testimonial":
      return [`> ${line(p.quote)}\n> — ${line(p.author)}${p.role ? `, ${line(p.role)}` : ""}`];
    case "image": {
      if (!p.src || p.decorative) return [];
      const img = `![${line(p.alt)}](${p.src})`;
      const link = href(p.href as string | undefined, ctx);
      return [[link ? `[${img}](${link})` : img, p.caption ? `*${line(p.caption)}*` : ""].filter(Boolean).join("\n")];
    }
    case "button": {
      const target = href(p.href as string, ctx);
      return target ? [`[${line(p.label)}](${target})`] : [];
    }
    case "video":
      return p.url ? [`[Video: ${line(p.title)}](${p.url})`] : [];
    case "divider":
      return ["---"];
    case "productGrid": {
      const limit = Number(p.limit ?? 12);
      let items: Product[] = [];
      if (p.source === "all") items = enabled();
      else if (p.source === "category") {
        const cat = ctx.categories.find((c) => c.slug === p.categorySlug);
        items = cat ? enabled().filter((x) => x.categoryId === cat.id) : [];
      } else if (p.source === "collection") {
        const coll = ctx.collections.find((c) => c.handle === p.collectionHandle);
        items = coll ? (await ctx.membersOf(coll.handle, limit)).filter((x) => x.enabled) : [];
      }
      const lines = productLines(items.slice(0, limit), ctx, p.showPrice !== false);
      return lines ? [lines] : [];
    }
    case "productCard": {
      const product = enabled().find((x) => x.slug === p.productSlug);
      return product ? [productLines([product], ctx)] : [];
    }
    case "repeater": {
      // On a page only the store's own products exist; other sources belong to templates.
      if ((p.source as RepeaterSource) !== "store.products" || !REPEATER_SOURCES[p.source as RepeaterSource]) return [];
      const lines = productLines(enabled().slice(0, Number(p.limit ?? 12)), ctx);
      return lines ? [lines] : [];
    }
    case "collectionList": {
      const items = ctx.collections.slice(0, Number(p.limit ?? 6));
      if (!items.length) return [];
      return [
        items
          .map((c) => `- [${line(c.title)}](${base(ctx)}/collections/${c.handle})${p.showDescriptions && c.description ? `: ${line(c.description)}` : ""}`)
          .join("\n"),
      ];
    }
    case "form":
      // A link to the form's own page, never its endpoint: agents read a store, they do not fill its inbox.
      return typeof p.formHandle === "string" && p.formHandle ? [`[Form: ${p.formHandle}](${base(ctx)}/forms/${p.formHandle})`] : [];
    case "root":
    case "section":
    case "columns":
    case "column":
    case "grid":
    case "row":
      return children();
    default:
      // Spacers, and blocks that only exist in templates and regions (Buy, gallery, menus).
      return [];
  }
}

export async function pageToMarkdown(tree: PageNode, ctx: MarkdownContext): Promise<string> {
  return (await block(tree, ctx)).filter((s) => s.trim() !== "").join("\n\n");
}
