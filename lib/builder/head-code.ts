import { load } from "cheerio";
import { HEAD_CODE_MAX } from "./types";

/**
 * Custom scripts — the merchant's head code (D51 M6, `docs/BUILDER.md` §8
 * levels 3–4, owner decision 2026-11-13: head snippets only, for analytics and
 * pixels; no script inside a custom HTML block).
 *
 * **Not a sanitiser in the custom-HTML sense.** The point of head code is to
 * run the merchant's JavaScript, so there is no making it "safe" — what keeps
 * it in bounds is *who* may write it (`cms.scripts`, a signed-in person with a
 * fresh second factor), *where* it runs (never the cart, account or preview),
 * and the storefront CSP's nonce, which only scripts we render carry.
 *
 * What this module does is make the stored text exactly what will render:
 * snippets are parsed and **rebuilt** into four element shapes — `<script>`,
 * `<meta>`, `<link rel=preconnect|dns-prefetch>` and a `<noscript>` holding
 * tracking images — and everything else is dropped and *named*, so the
 * merchant sees what did not survive instead of wondering why a tag is silent.
 * A `<meta http-equiv>` (which could rewrite the CSP or redirect the page), an
 * iframe, a stylesheet, a `<base>`, a `nonce` the merchant pasted: all gone.
 */

export type HeadScript = {
  kind: "script";
  /** External https:// source, or null for an inline script. */
  src: string | null;
  /** Inline code ("" for an external script). */
  code: string;
  async: boolean;
  defer: boolean;
  type: string | null;
  id: string | null;
  crossOrigin: "anonymous" | "use-credentials" | null;
  integrity: string | null;
  referrerPolicy: string | null;
  data: [string, string][];
};
export type HeadMeta = { kind: "meta"; attr: "name" | "property"; key: string; content: string };
export type HeadLink = { kind: "link"; rel: "preconnect" | "dns-prefetch"; href: string; crossOrigin: boolean };
export type HeadNoscript = { kind: "noscript"; images: { src: string; width: string | null; height: string | null; alt: string }[] };
export type HeadElement = HeadScript | HeadMeta | HeadLink | HeadNoscript;

const SCRIPT_TYPES = new Set(["text/javascript", "application/javascript", "module", "application/ld+json", "application/json"]);
const REFERRER_POLICIES = new Set([
  "no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin",
  "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url",
]);
/** Meta names the storefront sets itself, or that would change how the page behaves rather than describe it. */
const RESERVED_META = new Set(["viewport", "robots", "googlebot", "referrer", "color-scheme"]);
const INTEGRITY = /^(sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}( (sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2})*$/;
const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/i;
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i;

type DomNode = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: DomNode[] };

function textOf(n: DomNode): string {
  return (n.children ?? []).map((c) => (c.type === "text" ? (c.data ?? "") : textOf(c))).join("");
}

function attrsOf(n: DomNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(n.attribs ?? {})) out[k.toLowerCase()] = v;
  return out;
}

function parseScript(n: DomNode, removed: Set<string>): HeadScript | null {
  const a = attrsOf(n);
  const code = textOf(n).trim();
  let src: string | null = null;
  if ("src" in a) {
    src = a.src.trim();
    if (!HTTPS_URL.test(src)) {
      removed.add("a <script> whose src is not an https:// address");
      return null;
    }
    if (code) removed.add("code inside a <script src> (browsers ignore it)");
  }
  if (!src && !code) return null;
  // The end of a script is found by scanning its text; these change how that scan works.
  if (!src && /<!--|<script|<\/script/i.test(code)) {
    removed.add('an inline <script> containing "<!--" or "<script" (they change where browsers think the script ends)');
    return null;
  }
  const type = a.type?.trim().toLowerCase() || null;
  if (type && !SCRIPT_TYPES.has(type)) {
    removed.add(`a <script type="${type.slice(0, 40)}">`);
    return null;
  }
  const data: [string, string][] = [];
  for (const [k, v] of Object.entries(a)) {
    if (["src", "type", "async", "defer", "id", "crossorigin", "integrity", "referrerpolicy"].includes(k)) continue;
    if (/^data-[a-z][a-z0-9-]*$/.test(k) && !k.startsWith("data-mk") && v.length <= 500) {
      data.push([k, v]);
      continue;
    }
    removed.add(`the ${k} attribute on <script>`);
  }
  const crossOrigin = a.crossorigin === undefined ? null : a.crossorigin === "use-credentials" ? "use-credentials" : "anonymous";
  const integrity = a.integrity && INTEGRITY.test(a.integrity.trim()) ? a.integrity.trim() : null;
  if (a.integrity && !integrity) removed.add("an integrity value that is not a sha256/384/512 hash");
  const referrerPolicy = a.referrerpolicy && REFERRER_POLICIES.has(a.referrerpolicy) ? a.referrerpolicy : null;
  const id = a.id && /^[A-Za-z][\w-]{0,63}$/.test(a.id) ? a.id : null;
  return {
    kind: "script",
    src,
    code: src ? "" : code,
    async: src !== null && "async" in a,
    defer: src !== null && "defer" in a,
    type,
    id,
    crossOrigin,
    integrity,
    referrerPolicy,
    data,
  };
}

function parseMeta(n: DomNode, removed: Set<string>): HeadMeta | null {
  const a = attrsOf(n);
  if ("http-equiv" in a) {
    removed.add("<meta http-equiv> (it can redirect the page or replace its security policy)");
    return null;
  }
  if ("charset" in a) return null; // The page already declares one.
  const attr = "property" in a ? "property" : "name" in a ? "name" : null;
  const key = attr ? a[attr].trim() : "";
  if (!attr || !/^[A-Za-z][\w:.-]{0,63}$/.test(key) || a.content === undefined) {
    removed.add("a <meta> without a name or property and content");
    return null;
  }
  if (RESERVED_META.has(key.toLowerCase())) {
    removed.add(`<meta name="${key}"> (the storefront sets it)`);
    return null;
  }
  return { kind: "meta", attr, key, content: a.content.slice(0, 1000) };
}

function parseLink(n: DomNode, removed: Set<string>): HeadLink | null {
  const a = attrsOf(n);
  const rel = (a.rel ?? "").trim().toLowerCase();
  const href = (a.href ?? "").trim();
  if ((rel === "preconnect" || rel === "dns-prefetch") && HTTPS_ORIGIN.test(href)) {
    return { kind: "link", rel, href: href.replace(/\/$/, ""), crossOrigin: "crossorigin" in a };
  }
  removed.add(rel === "stylesheet" ? "a stylesheet <link> (use Custom CSS)" : `a <link rel="${rel.slice(0, 30) || "…"}">`);
  return null;
}

function parseNoscript(n: DomNode, removed: Set<string>): HeadNoscript | null {
  // Parsed with scripting on, a <noscript>'s content is raw text; read it as markup.
  const inner = load(textOf(n), null, false);
  const images: HeadNoscript["images"] = [];
  const walk = (nodes: DomNode[]) => {
    for (const c of nodes) {
      if (c.type !== "tag") continue;
      const tag = (c.name ?? "").toLowerCase();
      if (tag === "img") {
        const a = attrsOf(c);
        const src = (a.src ?? "").trim();
        if (!HTTPS_URL.test(src)) {
          removed.add("a <noscript> image whose src is not https://");
          continue;
        }
        const size = (v: string | undefined) => (v && /^\d{1,4}$/.test(v) ? v : null);
        images.push({ src, width: size(a.width), height: size(a.height), alt: a.alt ?? "" });
      } else {
        removed.add(`<${tag}> inside <noscript> (only tracking images are kept)`);
      }
    }
  };
  walk((inner.root()[0] as unknown as DomNode).children ?? []);
  return images.length ? { kind: "noscript", images } : null;
}

/** Head code parsed into the shapes the storefront renders, with what was dropped. Pure. */
export function parseHeadCode(input: string): { elements: HeadElement[]; removed: string[] } {
  const removed = new Set<string>();
  const elements: HeadElement[] = [];
  if (!input.trim()) return { elements, removed: [] };
  const $ = load(input, null, false);
  for (const n of ($.root()[0] as unknown as DomNode).children ?? []) {
    if (n.type === "text") {
      if ((n.data ?? "").trim()) removed.add("text outside an element");
      continue;
    }
    if (n.type === "comment" || n.type === "directive") continue;
    const tag = (n.name ?? "").toLowerCase();
    const el =
      tag === "script" ? parseScript(n, removed)
      : tag === "meta" ? parseMeta(n, removed)
      : tag === "link" ? parseLink(n, removed)
      : tag === "noscript" ? parseNoscript(n, removed)
      : (removed.add(`<${tag}>`), null);
    if (el) elements.push(el);
  }
  return { elements, removed: [...removed] };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function serializeHeadCode(elements: HeadElement[]): string {
  return elements
    .map((e) => {
      switch (e.kind) {
        case "script": {
          const attrs = [
            e.src ? `src="${esc(e.src)}"` : null,
            e.type ? `type="${esc(e.type)}"` : null,
            e.id ? `id="${esc(e.id)}"` : null,
            e.async ? "async" : null,
            e.defer ? "defer" : null,
            e.crossOrigin ? `crossorigin="${e.crossOrigin}"` : null,
            e.integrity ? `integrity="${esc(e.integrity)}"` : null,
            e.referrerPolicy ? `referrerpolicy="${esc(e.referrerPolicy)}"` : null,
            ...e.data.map(([k, v]) => `${k}="${esc(v)}"`),
          ].filter(Boolean);
          return `<script${attrs.length ? ` ${attrs.join(" ")}` : ""}>${e.code}</script>`;
        }
        case "meta":
          return `<meta ${e.attr}="${esc(e.key)}" content="${esc(e.content)}">`;
        case "link":
          return `<link rel="${e.rel}" href="${esc(e.href)}"${e.crossOrigin ? " crossorigin" : ""}>`;
        case "noscript":
          return `<noscript>${e.images
            .map((i) => `<img src="${esc(i.src)}"${i.width ? ` width="${i.width}"` : ""}${i.height ? ` height="${i.height}"` : ""} alt="${esc(i.alt)}">`)
            .join("")}</noscript>`;
      }
    })
    .join("\n");
}

/**
 * What `builder.setHeadCode` stores, and the problems that refuse it outright.
 * Dropped parts are reported, not refused — pasting a vendor's whole snippet
 * and keeping the parts that can work is the useful behaviour.
 */
export function cleanHeadCode(input: string): { html: string; removed: string[]; problems: string[] } {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (text.length > HEAD_CODE_MAX) {
    return { html: "", removed: [], problems: [`Custom scripts are limited to ${HEAD_CODE_MAX.toLocaleString("en-US")} characters.`] };
  }
  const { elements, removed } = parseHeadCode(text);
  if (text && elements.length === 0) {
    return { html: "", removed, problems: ["Nothing in this code can be used: it needs a <script>, <meta>, <link rel=\"preconnect\"> or <noscript> image."] };
  }
  return { html: serializeHeadCode(elements), removed, problems: [] };
}
