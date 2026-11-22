/**
 * Long-form Markdown for blog posts: the text blocks' subset (`./markdown`)
 * plus what an article needs and a page block does not — headings, images,
 * quotes, code and dividers. **Parsed to a tree, never to HTML**, and drawn by
 * `./article-view` through React, which escapes every string: raw HTML in a
 * post is text.
 *
 * - `#` and `##` are `h2`, `###` and deeper are `h3`. The post's title is the
 *   page's only `h1`, so a body heading can never compete with it, and heading
 *   order stays checkable.
 * - `![alt](https://…)` on a line of its own is an image. https only — an
 *   http image on an https storefront is blocked by the browser, and anything
 *   else is not an image; such a line renders as plain text.
 * - `> ` lines are a quote, a line of `---` / `***` a divider, and ``` fences a
 *   code block (its language tag is dropped).
 */
import { parseInline, safeHref, type Inline } from "./markdown";

export type ArticleBlock =
  | { type: "h2" | "h3"; c: Inline[] }
  | { type: "p"; c: Inline[] }
  | { type: "ul" | "ol"; items: Inline[][] }
  | { type: "quote"; c: Inline[] }
  | { type: "img"; src: string; alt: string }
  | { type: "code"; v: string }
  | { type: "hr" };

/** A post's body: enough for a long article, small enough to audit and to render per request. */
export const ARTICLE_MAX = 50_000;

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const IMAGE = /^!\[([^\]]*)\]\((\S+?)\)\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^```/;

/** An image URL a post may show: https, nothing else. */
export function articleImageUrl(raw: string): string | null {
  const url = raw.trim();
  return /^https:\/\/\S+$/i.test(url) && safeHref(url) ? url : null;
}

export function parseArticle(src: string): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  const lines = src.slice(0, ARTICLE_MAX).replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];

  const flushPara = () => {
    const kept = para.filter((l) => l.trim().length > 0);
    para = [];
    if (kept.length === 0) return;
    if (kept.every((l) => BULLET.test(l))) blocks.push({ type: "ul", items: kept.map((l) => parseInline(BULLET.exec(l)![1])) });
    else if (kept.every((l) => NUMBERED.test(l))) blocks.push({ type: "ol", items: kept.map((l) => parseInline(NUMBERED.exec(l)![1])) });
    else if (kept.every((l) => l.trimStart().startsWith(">"))) {
      blocks.push({ type: "quote", c: parseInline(kept.map((l) => l.trimStart().replace(/^>\s?/, "")).join("\n")) });
    } else blocks.push({ type: "p", c: parseInline(kept.join("\n")) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line.trim())) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i].trim())) code.push(lines[i++]);
      blocks.push({ type: "code", v: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    const heading = HEADING.exec(line.trim());
    if (heading) {
      flushPara();
      blocks.push({ type: heading[1].length <= 2 ? "h2" : "h3", c: parseInline(heading[2]) });
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      blocks.push({ type: "hr" });
      continue;
    }
    const image = IMAGE.exec(line.trim());
    if (image) {
      const src = articleImageUrl(image[2]);
      if (src) {
        flushPara();
        blocks.push({ type: "img", src, alt: image[1].trim() });
        continue;
      }
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

function flat(inlines: Inline[]): string {
  return inlines.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : flat(n.c))).join("");
}

/** The plain words of a post, for an excerpt nobody wrote and for checks. */
export function articleText(src: string): string {
  return parseArticle(src)
    .map((b) => {
      switch (b.type) {
        case "ul":
        case "ol":
          return b.items.map(flat).join(" ");
        case "img":
          return b.alt;
        case "code":
          return b.v;
        case "hr":
          return "";
        default:
          return flat(b.c);
      }
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** An excerpt cut on a word boundary, for a post that has none of its own. */
export function autoExcerpt(src: string, max = 200): string {
  const text = articleText(src);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

function inlineMd(nodes: Inline[], resolve: (href: string) => string | null): string {
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
          return `**${inlineMd(n.c, resolve)}**`;
        case "em":
          return `*${inlineMd(n.c, resolve)}*`;
        case "link": {
          const href = resolve(n.href);
          return href ? `[${inlineMd(n.c, resolve)}](${href})` : inlineMd(n.c, resolve);
        }
      }
    })
    .join("");
}

/**
 * The post re-written from its tree — for `llms-full.txt`. Re-serialised rather
 * than passed through, so what agents read is exactly what the page shows:
 * anything the parser did not accept is gone, and site paths are absolute.
 */
export function articleToMarkdown(src: string, baseUrl: string): string {
  const root = baseUrl.replace(/\/$/, "");
  const resolve = (href: string) => {
    const safe = safeHref(href);
    return safe ? (safe.startsWith("/") ? `${root}${safe}` : safe) : null;
  };
  return parseArticle(src)
    .map((b) => {
      switch (b.type) {
        case "h2":
          return `## ${inlineMd(b.c, resolve)}`;
        case "h3":
          return `### ${inlineMd(b.c, resolve)}`;
        case "p":
          return inlineMd(b.c, resolve);
        case "quote":
          return inlineMd(b.c, resolve)
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n");
        case "ul":
          return b.items.map((it) => `- ${inlineMd(it, resolve)}`).join("\n");
        case "ol":
          return b.items.map((it, i) => `${i + 1}. ${inlineMd(it, resolve)}`).join("\n");
        case "img":
          return `![${b.alt}](${b.src})`;
        case "code":
          return `\`\`\`\n${b.v}\n\`\`\``;
        case "hr":
          return "---";
      }
    })
    .join("\n\n");
}
