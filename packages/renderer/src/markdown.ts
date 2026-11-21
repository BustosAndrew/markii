/**
 * The rich-text format for text blocks: a **small Markdown subset parsed to a
 * tree, never to HTML** (D51).
 *
 * Paragraphs, line breaks, `-`/`*` and `1.` lists, `**bold**`, `*italic*` /
 * `_italic_`, `` `code` `` and `[links](/path)`. Headings are not here on
 * purpose — they are blocks, so heading order can be checked before publish.
 *
 * **Raw HTML is text.** The renderer turns this tree into React elements, which
 * escape every string, so `<script>` in a merchant's copy (or in something an
 * agent was tricked into writing) renders as the characters `<script>`. There
 * is no `dangerouslySetInnerHTML` anywhere on this path.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type MdBlock = { type: "p"; c: Inline[] } | { type: "ul" | "ol"; items: Inline[][] };

/**
 * Links a page may carry: site-relative paths, fragments, http(s) and mailto.
 * Anything else — `javascript:`, `data:`, protocol-relative `//host` — is not
 * a link, and its text renders plain.
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  if (/^\/(?!\/)[^\s]*$/.test(href)) return href;
  if (/^#[\w-]*$/.test(href)) return href;
  return null;
}

/** Inline markup within one line or paragraph. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };

  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    if (rest.startsWith("\n")) {
      flush();
      out.push({ t: "br" });
      i += 1;
      continue;
    }
    if (rest.startsWith("`")) {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**")) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (rest[0] === "*" || rest[0] === "_") {
      const mark = rest[0];
      const end = src.indexOf(mark, i + 1);
      if (end > i + 1 && src[i + 1] !== " ") {
        flush();
        out.push({ t: "em", c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (rest[0] === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
      if (m) {
        flush();
        const href = safeHref(m[2]);
        const c = parseInline(m[1]);
        if (href) out.push({ t: "link", href, c });
        else out.push(...c);
        i += m[0].length;
        continue;
      }
    }
    text += src[i];
    i += 1;
  }
  flush();
  return out;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const chunks = src.replace(/\r\n?/g, "\n").split(/\n{2,}/);

  for (const chunk of chunks) {
    const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    if (lines.every((l) => BULLET.test(l))) {
      blocks.push({ type: "ul", items: lines.map((l) => parseInline(BULLET.exec(l)![1])) });
    } else if (lines.every((l) => NUMBERED.test(l))) {
      blocks.push({ type: "ol", items: lines.map((l) => parseInline(NUMBERED.exec(l)![1])) });
    } else {
      blocks.push({ type: "p", c: parseInline(lines.join("\n")) });
    }
  }
  return blocks;
}

/** The plain words of a text block, for checks and for agents reading a page. */
export function markdownText(src: string): string {
  const flat = (inlines: Inline[]): string =>
    inlines
      .map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : flat(n.c)))
      .join("");
  return parseMarkdown(src)
    .map((b) => (b.type === "p" ? flat(b.c) : b.items.map(flat).join(" ")))
    .join(" ")
    .trim();
}
