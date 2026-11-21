import { load } from "cheerio";
import { CUSTOM_CSS_MAX } from "./types";

/**
 * Custom code, made safe to store and to serve (`docs/BUILDER.md` §8, M6).
 *
 * **HTML is rebuilt, never filtered in place.** The input is parsed, and the
 * output is written from scratch out of what an allowlist recognises: element
 * names, attributes and URL schemes it names, and text, escaped. Anything it
 * does not recognise cannot reach the output, because nothing copies input
 * through — there is no "remove the bad parts and serialise the rest", which
 * is where sanitisers leak (a mutation-XSS parse quirk, an attribute nobody
 * thought of).
 *
 * Applied twice: when the block is saved (so the draft holds clean HTML and
 * the merchant sees what will ship) and again when it renders (so a rule made
 * stricter later also covers HTML stored before it).
 *
 * **No script, style, iframe, form, svg or event handler, ever.** Scripts are a
 * separate, explicitly approved capability (not built); styling belongs in the
 * theme CSS; video has its own block.
 */

/** Elements kept, with the attributes each may carry beyond the global ones. */
const ELEMENTS: Record<string, readonly string[]> = {
  p: [], br: [], hr: [], div: [], span: [], section: [], article: [], aside: [], header: [], footer: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  strong: [], em: [], b: [], i: [], u: [], s: [], small: [], sub: [], sup: [], mark: [], abbr: [], cite: [], q: [],
  code: [], pre: [], kbd: [], blockquote: [], address: [],
  ul: [], ol: ["start", "reversed"], li: [], dl: [], dt: [], dd: [],
  figure: [], figcaption: [], details: ["open"], summary: [],
  table: [], caption: [], thead: [], tbody: [], tfoot: [], tr: [], th: ["colspan", "rowspan", "scope"], td: ["colspan", "rowspan"],
  time: ["datetime"],
  a: ["href", "target"],
  img: ["src", "alt", "width", "height", "loading"],
};

const VOID = new Set(["br", "hr", "img"]);

/** Dropped with everything inside them — their content is code or chrome, not copy. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "form",
  "input", "button", "select", "textarea", "option", "link", "meta", "base", "head", "title", "frame", "frameset", "canvas", "audio", "video", "source", "track", "dialog",
]);

const GLOBAL_ATTRS = new Set(["class", "id", "title", "lang", "dir", "role"]);


function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Links a custom block may carry: http(s), mailto, tel, site-relative paths and fragments. */
function safeLink(raw: string): string | null {
  const v = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(v)) return v;
  if (/^(mailto|tel):[^\s]+$/i.test(v)) return v;
  if (/^\/(?!\/)[^\s]*$/.test(v)) return v;
  if (/^#[\w-]*$/.test(v)) return v;
  return null;
}

/** Images are https only — an http image on an https store is blocked anyway, and `data:` is never needed. */
function safeImage(raw: string): string | null {
  const v = raw.trim();
  return /^https:\/\/[^\s]+$/i.test(v) ? v : null;
}

/** `class` tokens a merchant may use; `mk-` and `sf-` belong to the builder and the themes. */
export const CLASS_TOKEN = /^[A-Za-z_][\w-]{0,39}$/;
export function reservedClass(token: string): boolean {
  return /^(mk|sf)-/i.test(token);
}

function cleanClass(value: string): string {
  return value
    .split(/\s+/)
    .filter((t) => CLASS_TOKEN.test(t) && !reservedClass(t))
    .slice(0, 10)
    .join(" ");
}

function cleanAttrs(tag: string, attribs: Record<string, string>): string {
  const allowed = ELEMENTS[tag] ?? [];
  const out: string[] = [];
  for (const [rawName, rawValue] of Object.entries(attribs)) {
    const name = rawName.toLowerCase();
    let value: string | null = rawValue;
    if (name.startsWith("aria-") && /^aria-[a-z]+$/.test(name)) {
      // Accessible names and states — text, no behaviour.
    } else if (name.startsWith("data-")) {
      // The editor's own hooks may not be imitated: a block must not claim to be another node.
      if (!/^data-[a-z][a-z0-9-]*$/.test(name) || name.startsWith("data-mk")) continue;
    } else if (GLOBAL_ATTRS.has(name)) {
      if (name === "class") value = cleanClass(rawValue);
      if (name === "id" && !/^[A-Za-z][\w-]{0,63}$/.test(rawValue)) continue;
    } else if (allowed.includes(name)) {
      if (name === "href") value = safeLink(rawValue);
      if (name === "src") value = safeImage(rawValue);
      if (name === "target") value = rawValue === "_blank" ? "_blank" : null;
      if (["width", "height", "colspan", "rowspan", "start"].includes(name) && !/^\d{1,4}$/.test(rawValue)) continue;
      if (name === "loading" && rawValue !== "lazy" && rawValue !== "eager") continue;
      if (name === "scope" && !["row", "col", "rowgroup", "colgroup"].includes(rawValue)) continue;
    } else {
      // Every event handler, style attribute, srcset, formaction, … — anything not named above.
      continue;
    }
    if (value === null || value === "") {
      if (name === "alt") out.push('alt=""');
      continue;
    }
    out.push(`${name}="${escapeAttr(value)}"`);
  }
  // A new tab must not hand the store's window to the page it opens.
  if (tag === "a" && attribs.target === "_blank") out.push('rel="noopener noreferrer"');
  return out.length ? ` ${out.join(" ")}` : "";
}

type DomNode = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: DomNode[] };

function write(nodes: DomNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") {
      out += escapeText(n.data ?? "");
      continue;
    }
    if (n.type !== "tag" && n.type !== "script" && n.type !== "style") continue; // comments, directives, CDATA
    const tag = (n.name ?? "").toLowerCase();
    if (DROP_WITH_CONTENT.has(tag) || n.type !== "tag") continue;
    if (!(tag in ELEMENTS)) {
      // An unknown element — `<font>`, `<center>`, a custom element — keeps its text, loses itself.
      out += write(n.children ?? []);
      continue;
    }
    if (tag === "img" && !safeImage(n.attribs?.src ?? "")) continue;
    const attrs = cleanAttrs(tag, n.attribs ?? {});
    out += VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${write(n.children ?? [])}</${tag}>`;
  }
  return out;
}

/** HTML a custom block may hold, rebuilt from the allowlist. Pure and deterministic. */
export function sanitizeHtml(input: string): string {
  if (!input.trim()) return "";
  const $ = load(input, null, false);
  return write(($.root()[0] as unknown as DomNode).children ?? []).trim();
}

/**
 * Theme CSS, checked rather than rewritten (`docs/BUILDER.md` §8 level 2):
 * returns the reasons it is refused, empty when it is fine. It lands inside a
 * `<style>` element, so `<` is refused outright — nothing can close the tag —
 * and so is anything that fetches or runs: `@import`, `url()` other than
 * https, `expression()`, `javascript:`, legacy `behavior` / `-moz-binding`.
 */
export function cssProblems(css: string): string[] {
  const problems: string[] = [];
  if (css.length > CUSTOM_CSS_MAX) problems.push(`Custom CSS is limited to ${CUSTOM_CSS_MAX.toLocaleString("en-US")} characters.`);
  if (css.includes("<")) problems.push("Custom CSS may not contain \"<\".");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import/i.test(code)) problems.push("@import is not allowed; put the rules here instead.");
  if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(code)) problems.push("Script in CSS is not allowed.");
  for (const m of code.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!/^https:\/\//i.test(m[2].trim())) problems.push(`url(${m[2].trim() || "…"}) must be an https:// address.`);
  }
  let depth = 0;
  for (const ch of code) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) problems.push("Custom CSS has unbalanced braces.");
  return [...new Set(problems)];
}
