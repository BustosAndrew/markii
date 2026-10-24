import { lookup } from "node:dns/promises";
import * as cheerio from "cheerio";
import { badRequest, slugify } from "@/lib/api";
import { currencyExponent } from "@/lib/api/money";

/**
 * The importer (§5) — parse a CSV, or read a Shopify / WooCommerce / JSON-LD
 * store, into staged products. Nothing is saved here; `/api/import/commit`
 * writes what the merchant keeps.
 *
 * **It reports what it could not know rather than inventing it.** Until
 * 2026-10-22 every product whose source published no stock count was staged
 * with a stock of 10, Shopify prices were labelled USD whatever the store
 * sold in, catalogues past 250 (Shopify) or 100 (WooCommerce) products were
 * cut off silently, and multi-variant products kept only their first
 * variant. Each of those is now either read from the source, staged as
 * unknown with a warning, or refused with a reason.
 */

export type StagedVariant = {
  title: string;
  /** Option name → value, matching the product's `options`. */
  optionValues: Record<string, string>;
  priceCents: number;
  compareAtCents: number | null;
  sku: string | null;
};

export type StagedProduct = {
  tempId: string;
  name: string;
  slug: string;
  /**
   * Two-decimal minor units, the legacy `Cents` shape (§1–8, D31). Only
   * currencies with two decimals are staged at all — see
   * {@link importableCurrency}.
   */
  priceCents: number;
  currency: string;
  sku: string | null;
  /** 0 when the source does not publish a count; `stockKnown` says which. */
  stock: number;
  /**
   * False when the source said nothing usable about quantity. The product is
   * staged at 0 rather than at a made-up number, so it cannot be oversold —
   * the merchant sets the real count.
   */
  stockKnown: boolean;
  /** Plain text. HTML from the source is converted, entities decoded. */
  description: string | null;
  images: string[];
  categoryName: string | null;
  /** Option axes (≤ 3). Absent for a single-variant product. */
  options?: { name: string; values: string[] }[];
  variants?: StagedVariant[];
  /**
   * Provenance, stored on the product at commit (`products.import_*`).
   * `sourceId` is the source platform's own product id — Shopify and
   * WooCommerce have one; CSV rows and scraped pages do not.
   */
  source: ImportResult["source"];
  sourceId: string | null;
  sourceUrl: string | null;
};

export type ImportWarningCode =
  | "STOCK_UNKNOWN"
  | "TRUNCATED"
  | "VARIANTS_NOT_IMPORTED"
  | "IMAGES_TRUNCATED"
  | "CURRENCY_ASSUMED";

/** Something the merchant should know before committing — the import still worked. */
export type ImportWarning = { code: ImportWarningCode; message: string; tempIds?: string[] };

export type ImportResult = {
  source: "csv" | "shopify" | "woocommerce" | "scrape";
  imported: StagedProduct[];
  categories: { tempId: string; name: string }[];
  failed: { row?: number; url?: string; name?: string; reason: string }[];
  warnings: ImportWarning[];
};

/** The most products one import stages. Past it the result says so; CSV has no cap. */
export const MAX_IMPORT_PRODUCTS = 1_000;
/**
 * WooCommerce variation reads one import may make. The Store API lists a
 * variable product's variation ids but not their prices, so each variation is
 * a request of its own; past this budget the remaining variable products come
 * in as their base product, with a warning naming them.
 */
export const MAX_VARIATION_FETCHES = 500;
const VARIATION_CONCURRENCY = 6;
/** Product images accepted per product (`productCreateSchema` allows 20). */
const MAX_IMAGES = 20;

// ---------- money ----------

/**
 * Whether prices in this currency can be imported.
 *
 * **Only two-decimal currencies, for now.** The legacy `priceCents` field is
 * read two ways: the storefront divides it by 100 for every currency, while
 * checkout hands it to Stripe as the currency's own minor unit. For USD or
 * EUR those agree; for JPY (no decimals) or KWD (three) they disagree by a
 * factor of 100 or 10, so an imported yen product would show one price and
 * charge another. Refusing is better than creating that store. Lift this when
 * the two readers agree (`docs/API.md` §5).
 *
 * **Three-letter ISO codes only.** `USDC` once passed here, but every product
 * schema — preview, import commit, product create — requires exactly three
 * letters, so one USDC row failed the wizard's whole preview and would have
 * failed the whole commit batch. x402 settles in USDC; products are priced in
 * a currency.
 */
export function importableCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && currencyExponent(code) === 2;
}

/**
 * A decimal price — `"19.99"`, `19.9`, `"1,299.00"`, `"19,99"` — as integer
 * two-decimal minor units, without floating-point arithmetic.
 *
 * Returns null for anything that is not a non-negative amount, or that has
 * real precision below a cent (`"19.995"`): rounding a price is a decision
 * about money, and an importer should not be the one making it.
 */
export function parsePriceToCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  let s = (typeof value === "number" ? String(value) : String(value)).trim();
  if (/e/i.test(s)) return null;
  s = s.replace(/[^0-9.,-]/g, "");
  if (!s || s.startsWith("-")) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Whichever comes last is the decimal separator; the other groups thousands.
    s = lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    // "1,299" groups thousands; "19,99" is a decimal comma.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  }

  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const whole = m[1];
  let frac = m[2] ?? "";
  if (frac.length > 2) {
    if (/[^0]/.test(frac.slice(2))) return null;
    frac = frac.slice(0, 2);
  }
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Integer minor units in some exponent → two-decimal minor units, exactly.
 * Null when it cannot be done without rounding (more than two decimals that
 * are not all zero).
 */
function toTwoDecimals(raw: number, exponent: number): number | null {
  if (!Number.isSafeInteger(raw) || raw < 0) return null;
  if (exponent === 2) return raw;
  if (exponent < 2) return raw * 10 ** (2 - exponent);
  const divisor = 10 ** (exponent - 2);
  return raw % divisor === 0 ? raw / divisor : null;
}

// ---------- text ----------

const BLOCK_TAGS = "p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,table,section,article,blockquote";

/**
 * HTML from a source store → plain text with paragraph breaks.
 *
 * The storefront strips tags anyway, but naively — entities stay encoded and
 * paragraphs run together — and the Catalog agent, `llms.txt` and JSON-LD all
 * read the stored text. Converting once, at the door, is cheaper than every
 * reader coping.
 */
export function htmlToText(input: string | null | undefined): string | null {
  if (!input) return null;
  if (!/<[a-z!/][\s\S]*>/i.test(input) && !/&[a-z#0-9]+;/i.test(input)) {
    return input.trim() || null;
  }
  const $ = cheerio.load(`<div id="__root">${input}</div>`);
  $("script,style,noscript,iframe").remove();
  $("br").replaceWith("\n");
  $(BLOCK_TAGS).each((_, el) => {
    $(el).append("\n\n");
  });
  const text = $("#__root")
    .text()
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function collectCategories(items: StagedProduct[]): { tempId: string; name: string }[] {
  const names = [...new Set(items.map((i) => i.categoryName).filter((n): n is string => !!n))];
  return names.map((name, i) => ({ tempId: `cat_${i + 1}`, name }));
}

function clipImages(images: unknown[]): { images: string[]; clipped: boolean } {
  const all = images.map(String).filter(Boolean);
  return { images: all.slice(0, MAX_IMAGES), clipped: all.length > MAX_IMAGES };
}

/** The warnings every source can raise from its staged products. */
function commonWarnings(items: StagedProduct[], clippedImages: string[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  const unknown = items.filter((i) => !i.stockKnown).map((i) => i.tempId);
  if (unknown.length) {
    warnings.push({
      code: "STOCK_UNKNOWN",
      message:
        `${unknown.length} product${unknown.length === 1 ? "" : "s"} came without a stock count, so ` +
        `${unknown.length === 1 ? "it was" : "they were"} staged at 0 and cannot be bought until you ` +
        "set the real quantity.",
      tempIds: unknown,
    });
  }
  if (clippedImages.length) {
    warnings.push({
      code: "IMAGES_TRUNCATED",
      message: `${clippedImages.length} product(s) had more than ${MAX_IMAGES} images; the first ${MAX_IMAGES} were kept.`,
      tempIds: clippedImages,
    });
  }
  return warnings;
}

// ---------- CSV ----------

/** Minimal RFC-4180-ish parser (quotes, escaped quotes, CRLF). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * `defaultCurrency` is the organization's own currency: a CSV is the
 * merchant's own file, so a missing currency column means "mine" — and the
 * result says it was assumed, rather than silently meaning USD.
 */
export function importFromCsv(text: string, opts: { defaultCurrency: string }): ImportResult {
  const empty = (reason: string): ImportResult => ({
    source: "csv",
    imported: [],
    categories: [],
    failed: [{ reason }],
    warnings: [],
  });
  const rows = parseCsvRows(text);
  if (rows.length < 2) return empty("CSV needs a header row and at least one data row");

  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (row: string[], name: string): string => {
    const i = header.indexOf(name);
    return i >= 0 ? (row[i] ?? "").trim() : "";
  };
  if (!header.includes("name")) {
    return empty(`CSV header must include a "name" column (got: ${header.join(", ")})`);
  }

  const imported: StagedProduct[] = [];
  const failed: ImportResult["failed"] = [];
  const clipped: string[] = [];
  let assumedCurrency = 0;
  const fallbackCurrency = opts.defaultCurrency.toUpperCase();

  rows.slice(1).forEach((row, idx) => {
    const rowNum = idx + 2; // 1-based, after header
    const name = col(row, "name");
    if (!name) {
      failed.push({ row: rowNum, reason: "missing name" });
      return;
    }
    const priceCents = parsePriceToCents(col(row, "price"));
    if (priceCents == null) {
      failed.push({ row: rowNum, name, reason: "price is not a number, or has fractions of a cent" });
      return;
    }
    const stated = col(row, "currency").toUpperCase();
    if (!stated) assumedCurrency++;
    const currency = stated || fallbackCurrency;
    if (!importableCurrency(currency)) {
      failed.push({ row: rowNum, name, reason: unsupportedCurrencyReason(currency) });
      return;
    }

    const rawStock = col(row, "stock");
    const stock = /^\d+$/.test(rawStock) ? parseInt(rawStock, 10) : null;
    const tempId = `imp_${imported.length + 1}`;
    const { images, clipped: wasClipped } = clipImages(
      col(row, "image_url") ? col(row, "image_url").split("|").map((s) => s.trim()) : [],
    );
    if (wasClipped) clipped.push(tempId);

    imported.push({
      tempId,
      name,
      slug: col(row, "slug") ? slugify(col(row, "slug")) : slugify(name),
      priceCents,
      currency,
      sku: col(row, "sku") || null,
      stock: stock ?? 0,
      stockKnown: stock != null,
      description: htmlToText(col(row, "description")),
      images,
      categoryName: col(row, "category") || null,
      source: "csv",
      sourceId: null,
      sourceUrl: null,
    });
  });

  const warnings = commonWarnings(imported, clipped);
  if (assumedCurrency) {
    warnings.push({
      code: "CURRENCY_ASSUMED",
      message: `${assumedCurrency} row(s) had no currency, so your organization's currency (${fallbackCurrency}) was used.`,
    });
  }
  return { source: "csv", imported, categories: collectCategories(imported), failed, warnings };
}

function unsupportedCurrencyReason(currency: string): string {
  return /^[A-Z]{3}$/.test(currency)
    ? `prices in ${currency} cannot be imported yet — only currencies with two decimal places are supported`
    : `"${currency}" is not a currency code`;
}

// ---------- SSRF protection ----------

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    // loopback, link-local, unique-local; ::ffff:a.b.c.d is checked as IPv4 below
    if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80") || /^f[cd]/.test(v6)) return true;
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || // this-network
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast / reserved
  );
}

/**
 * Importer fetches are server-side requests to a user-supplied host, so they must
 * not be usable to reach internal services or cloud metadata endpoints.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("only http and https URLs can be imported");
  }
  if (url.username || url.password) {
    throw badRequest("URLs with embedded credentials are not allowed");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    throw badRequest(`refusing to import from internal host "${host}"`);
  }

  // resolve first so DNS names pointing at private space are rejected too
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.some((a) => isPrivateAddress(a.address))) {
      throw badRequest(`refusing to import from private address for "${host}"`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("refusing")) throw e;
    throw badRequest(`could not resolve host "${host}"`);
  }

  return url;
}

// ---------- fetching ----------

const FETCH_HEADERS = { "user-agent": "Markii-Importer/1.0 (+https://markii.app)" };
const MAX_REDIRECTS = 3;

/**
 * `fetch`, with every redirect hop checked against private address space.
 *
 * Following redirects automatically let a public host `302` the importer into
 * `169.254.169.254` or a private service — the URL was validated, the place it
 * ended up was not. Redirects are now followed by hand, re-validating each
 * `Location`. DNS rebinding between the check and the connection remains a
 * residual risk, as it is for any check-then-connect.
 */
async function safeFetch(raw: string): Promise<Response | null> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      await assertPublicUrl(current);
      const res = await fetch(current, {
        headers: FETCH_HEADERS,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return null;
        current = new URL(location, current).href;
        continue;
      }
      return res.ok ? res : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const res = await safeFetch(url);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  const res = await safeFetch(url);
  if (!res) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- Shopify ----------

/**
 * The store's currency, from Shopify's public endpoints. `/products.json`
 * carries prices with no currency at all, which is how every Shopify import
 * came to be labelled USD.
 */
async function shopifyCurrency(origin: string): Promise<string | null> {
  for (const path of ["/meta.json", "/cart.js"]) {
    const data = (await fetchJson(`${origin}${path}`)) as any;
    const code = typeof data?.currency === "string" ? data.currency.trim().toUpperCase() : "";
    if (/^[A-Z]{3}$/.test(code)) return code;
  }
  return null;
}

/** One `/products.json` page → staged products, in a known currency. */
export function fromShopify(
  data: any,
  currency: string,
  startIndex = 0,
  origin: string | null = null,
): { items: StagedProduct[]; failed: ImportResult["failed"]; clipped: string[] } {
  const items: StagedProduct[] = [];
  const failed: ImportResult["failed"] = [];
  const clipped: string[] = [];

  for (const p of data?.products ?? []) {
    if (!p?.title) continue;
    const rawVariants: any[] = Array.isArray(p.variants) ? p.variants : [];
    const first = rawVariants[0];
    const priceCents = parsePriceToCents(first?.price);
    if (priceCents == null) {
      failed.push({ name: p.title, reason: "no readable price" });
      continue;
    }

    const tempId = `imp_${startIndex + items.length + 1}`;
    const { images, clipped: wasClipped } = clipImages(
      (p.images ?? []).map((i: any) => i?.src).filter(Boolean),
    );
    if (wasClipped) clipped.push(tempId);

    // Shopify publishes quantity only when a store opts in; usually it is absent.
    const quantities = rawVariants.map((v) => v?.inventory_quantity);
    const stockKnown = quantities.length > 0 && quantities.every((q) => Number.isInteger(q));
    const stock = stockKnown ? Math.max(0, quantities.reduce((sum, q) => sum + q, 0)) : 0;

    /**
     * Shopify gives a single-variant product one option, "Title", with the
     * value "Default Title" — that is the absence of variants, not a variant.
     */
    const options: { name: string; values: string[] }[] = (p.options ?? [])
      .filter((o: any) => o?.name && Array.isArray(o.values) && o.values.length)
      .map((o: any) => ({ name: String(o.name).trim(), values: o.values.map((v: any) => String(v).trim()) }));
    const isDefaultOnly =
      rawVariants.length <= 1 &&
      (options.length === 0 || (options.length === 1 && options[0].values.join() === "Default Title"));

    let staged: Pick<StagedProduct, "options" | "variants"> = {};
    if (!isDefaultOnly && options.length > 0 && options.length <= 3) {
      const variants: StagedVariant[] = [];
      for (const v of rawVariants) {
        const optionValues: Record<string, string> = {};
        options.forEach((o, i) => {
          const value = v?.[`option${i + 1}`];
          if (value != null) optionValues[o.name] = String(value).trim();
        });
        const vPrice = parsePriceToCents(v?.price);
        if (vPrice == null || Object.keys(optionValues).length !== options.length) continue;
        variants.push({
          title: String(v?.title ?? Object.values(optionValues).join(" / ")),
          optionValues,
          priceCents: vPrice,
          compareAtCents: parsePriceToCents(v?.compare_at_price),
          sku: v?.sku ? String(v.sku) : null,
        });
      }
      if (variants.length) staged = { options, variants };
    }

    items.push({
      tempId,
      name: String(p.title),
      slug: slugify(p.handle || p.title),
      priceCents,
      currency,
      sku: staged.variants ? null : first?.sku || null,
      stock,
      stockKnown,
      description: htmlToText(p.body_html),
      images,
      categoryName: p.product_type || null,
      ...staged,
      source: "shopify",
      sourceId: p.id != null ? String(p.id) : null,
      sourceUrl: origin && p.handle ? `${origin}/products/${p.handle}` : null,
    });
  }
  return { items, failed, clipped };
}

async function importShopify(origin: string, first: any): Promise<ImportResult | null> {
  const currency = await shopifyCurrency(origin);
  if (!currency) {
    return {
      source: "shopify",
      imported: [],
      categories: [],
      failed: [
        {
          url: origin,
          reason:
            "This looks like a Shopify store, but its currency could not be read, so its prices " +
            "cannot be imported safely. Export a CSV from Shopify instead and include a currency column.",
        },
      ],
      warnings: [],
    };
  }
  if (!importableCurrency(currency)) {
    return {
      source: "shopify",
      imported: [],
      categories: [],
      failed: [{ url: origin, reason: unsupportedCurrencyReason(currency) }],
      warnings: [],
    };
  }

  const items: StagedProduct[] = [];
  const failed: ImportResult["failed"] = [];
  const clipped: string[] = [];
  const PAGE = 250;
  let page = first;
  let pageNo = 1;
  let truncated = false;
  while (page) {
    const parsed = fromShopify(page, currency, items.length, origin);
    items.push(...parsed.items);
    failed.push(...parsed.failed);
    clipped.push(...parsed.clipped);
    const count = Array.isArray(page?.products) ? page.products.length : 0;
    if (count < PAGE) break;
    if (items.length >= MAX_IMPORT_PRODUCTS) {
      truncated = true;
      break;
    }
    pageNo += 1;
    page = await fetchJson(`${origin}/products.json?limit=${PAGE}&page=${pageNo}`);
  }
  if (items.length > MAX_IMPORT_PRODUCTS) {
    items.length = MAX_IMPORT_PRODUCTS;
    truncated = true;
  }
  if (!items.length) return null;

  const warnings = commonWarnings(items, clipped);
  if (truncated) warnings.push(truncatedWarning());
  return { source: "shopify", imported: items, categories: collectCategories(items), failed, warnings };
}

function truncatedWarning(): ImportWarning {
  return {
    code: "TRUNCATED",
    message:
      `The store has more than ${MAX_IMPORT_PRODUCTS} products; the first ${MAX_IMPORT_PRODUCTS} were ` +
      "staged. Import the rest from a CSV export.",
  };
}

// ---------- WooCommerce ----------

/** A variable product's variation ids, as the Store API lists them. */
export function wooVariationIds(p: any): number[] {
  return (Array.isArray(p?.variations) ? p.variations : [])
    .map((v: any) => v?.id)
    .filter((id: unknown): id is number => Number.isInteger(id));
}

/**
 * A WooCommerce variable product's options and variants, from the parent's
 * attribute terms and each variation's own record.
 *
 * **All or nothing.** If any variation is missing (not fetched, or failed),
 * names an attribute value of "any" — WooCommerce's wildcard, which has no
 * single cell in an option matrix — or is priced in another currency, this
 * returns null and the product comes in as its base, flagged. A product with
 * some of its variants would be a product a shopper cannot buy in the size
 * the merchant actually stocks.
 */
export function wooVariants(
  p: any,
  variationsById: Map<number, any>,
  currency: string,
): { options: { name: string; values: string[] }[]; variants: StagedVariant[] } | null {
  const attrs: any[] = (Array.isArray(p?.attributes) ? p.attributes : []).filter(
    (a: any) => a?.has_variations && a?.name && Array.isArray(a.terms) && a.terms.length > 0,
  );
  const refs: any[] = Array.isArray(p?.variations) ? p.variations : [];
  if (attrs.length === 0 || attrs.length > 3 || refs.length === 0) return null;

  const label = (raw: unknown) => htmlToText(String(raw)) ?? String(raw);
  const options = attrs.map((a) => ({
    name: label(a.name),
    values: [...new Set<string>(a.terms.map((t: any) => label(t.name)))],
  }));

  const variants: StagedVariant[] = [];
  for (const ref of refs) {
    const v = variationsById.get(ref?.id);
    if (!v) return null;

    const optionValues: Record<string, string> = {};
    for (const pick of Array.isArray(ref.attributes) ? ref.attributes : []) {
      const wanted = String(pick?.name ?? "").toLowerCase();
      const i = attrs.findIndex(
        (a) => String(a.name).toLowerCase() === wanted || String(a.taxonomy ?? "").toLowerCase() === wanted,
      );
      const value = String(pick?.value ?? "");
      if (i < 0 || !value) return null; // unknown attribute, or "any"
      const term = attrs[i].terms.find(
        (t: any) => t.slug === value || String(t.name).toLowerCase() === value.toLowerCase(),
      );
      if (!term) return null;
      optionValues[options[i].name] = label(term.name);
    }
    if (Object.keys(optionValues).length !== options.length) return null;

    if (String(v.prices?.currency_code ?? "").toUpperCase() !== currency) return null;
    const minor = Number.isInteger(v.prices?.currency_minor_unit) ? v.prices.currency_minor_unit : 2;
    const read = (raw: unknown) =>
      /^\d+$/.test(String(raw ?? "")) ? toTwoDecimals(Number(raw), minor) : null;
    const price = read(v.prices?.price);
    if (price == null) return null;
    const regular = read(v.prices?.regular_price);

    variants.push({
      title: Object.values(optionValues).join(" / "),
      optionValues,
      priceCents: price,
      compareAtCents: regular != null && regular > price ? regular : null,
      sku: v.sku ? String(v.sku) : null,
    });
  }
  return { options, variants };
}

/**
 * Store API products → staged products. Currency comes per product from the
 * API itself. `variationsById` holds the variation records `importWoo`
 * fetched; a variable product whose variations are all there comes in with
 * its variants, any other comes in as its base and is listed in
 * `withVariations`.
 */
export function fromWoo(
  data: any,
  startIndex = 0,
  variationsById: Map<number, any> = new Map(),
): {
  items: StagedProduct[];
  failed: ImportResult["failed"];
  clipped: string[];
  withVariations: string[];
} {
  const items: StagedProduct[] = [];
  const failed: ImportResult["failed"] = [];
  const clipped: string[] = [];
  const withVariations: string[] = [];
  if (!Array.isArray(data)) return { items, failed, clipped, withVariations };

  for (const p of data) {
    if (!p?.name) continue;
    const name = htmlToText(String(p.name)) ?? String(p.name);
    const currency = String(p.prices?.currency_code ?? "").toUpperCase();
    if (!currency) {
      failed.push({ name, reason: "no currency stated" });
      continue;
    }
    if (!importableCurrency(currency)) {
      failed.push({ name, reason: unsupportedCurrencyReason(currency) });
      continue;
    }
    const raw = /^\d+$/.test(String(p.prices?.price ?? "")) ? Number(p.prices.price) : NaN;
    const minorUnit = Number.isInteger(p.prices?.currency_minor_unit) ? p.prices.currency_minor_unit : 2;
    const priceCents = Number.isFinite(raw) ? toTwoDecimals(raw, minorUnit) : null;
    if (priceCents == null) {
      failed.push({ name, reason: "no readable price" });
      continue;
    }

    const tempId = `imp_${startIndex + items.length + 1}`;
    const { images, clipped: wasClipped } = clipImages(
      (p.images ?? []).map((i: any) => i?.src).filter(Boolean),
    );
    if (wasClipped) clipped.push(tempId);
    let staged: Pick<StagedProduct, "options" | "variants"> = {};
    if (p.type === "variable" || wooVariationIds(p).length > 0) {
      const built = wooVariants(p, variationsById, currency);
      if (built) staged = built;
      else withVariations.push(tempId);
    }

    /**
     * The Store API publishes a number only when stock is low; otherwise just
     * in-stock or not. "Out of stock" is a real 0; "in stock" is unknown.
     */
    const low = p.low_stock_remaining;
    const stockKnown = p.is_in_stock === false || Number.isInteger(low);
    const stock = p.is_in_stock === false ? 0 : Number.isInteger(low) ? Math.max(0, low) : 0;

    items.push({
      tempId,
      name,
      slug: slugify(p.slug || name),
      priceCents,
      currency,
      // A variable product's parent SKU names no sellable thing; each variant carries its own.
      sku: staged.variants ? null : p.sku || null,
      stock,
      stockKnown,
      description: htmlToText(p.description || p.short_description),
      images,
      categoryName: p.categories?.[0]?.name ? (htmlToText(p.categories[0].name) ?? null) : null,
      ...staged,
      source: "woocommerce",
      sourceId: p.id != null ? String(p.id) : null,
      sourceUrl: typeof p.permalink === "string" && /^https?:\/\//.test(p.permalink) ? p.permalink : null,
    });
  }
  return { items, failed, clipped, withVariations };
}

/** `fn` over `inputs`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(inputs: T[], limit: number, fn: (input: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(inputs.length);
  let next = 0;
  async function worker() {
    while (next < inputs.length) {
      const i = next++;
      out[i] = await fn(inputs[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return out;
}

async function importWoo(origin: string, first: any): Promise<ImportResult | null> {
  const PAGE = 100;
  const raws: any[] = [];
  let page = first;
  let pageNo = 1;
  let truncated = false;
  while (Array.isArray(page)) {
    raws.push(...page);
    if (page.length < PAGE) break;
    if (raws.length >= MAX_IMPORT_PRODUCTS) {
      truncated = true;
      break;
    }
    pageNo += 1;
    page = await fetchJson(`${origin}/wp-json/wc/store/v1/products?per_page=${PAGE}&page=${pageNo}`);
  }
  if (raws.length > MAX_IMPORT_PRODUCTS) {
    raws.length = MAX_IMPORT_PRODUCTS;
    truncated = true;
  }

  // Variations: whole products only, within the budget, in catalogue order.
  const wanted: number[] = [];
  for (const p of raws) {
    const ids = wooVariationIds(p);
    if (ids.length === 0) continue;
    if (wanted.length + ids.length > MAX_VARIATION_FETCHES) break;
    wanted.push(...ids);
  }
  const records = await mapLimit(wanted, VARIATION_CONCURRENCY, (id) =>
    fetchJson(`${origin}/wp-json/wc/store/v1/products/${id}`),
  );
  const variationsById = new Map<number, any>();
  records.forEach((r, i) => {
    if (r && typeof r === "object") variationsById.set(wanted[i], r);
  });

  const { items, failed, clipped, withVariations } = fromWoo(raws, 0, variationsById);
  if (!items.length && !failed.length) return null;

  const warnings = commonWarnings(items, clipped);
  if (withVariations.length) {
    warnings.push({
      code: "VARIANTS_NOT_IMPORTED",
      message:
        `${withVariations.length} product(s) have variations (sizes, colours) in WooCommerce that ` +
        "could not all be read — some were unavailable, used an \"any\" value, or the import reached " +
        `its limit of ${MAX_VARIATION_FETCHES} variations. Those came in as the base product; add ` +
        "their options after importing.",
      tempIds: withVariations,
    });
  }
  if (truncated) warnings.push(truncatedWarning());
  return { source: "woocommerce", imported: items, categories: collectCategories(items), failed, warnings };
}

// ---------- JSON-LD scrape ----------

export function productsFromJsonLd(html: string, pageUrl: string | null = null): {
  items: Omit<StagedProduct, "tempId">[];
  failed: ImportResult["failed"];
} {
  const $ = cheerio.load(html);
  const items: Omit<StagedProduct, "tempId">[] = [];
  const failed: ImportResult["failed"] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed["@graph"] ?? [])];
      for (const node of nodes) {
        if (node?.["@type"] !== "Product" && !(Array.isArray(node?.["@type"]) && node["@type"].includes("Product")))
          continue;
        if (!node.name) continue;
        const name = String(node.name);
        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const priceCents = parsePriceToCents(offer?.price ?? offer?.lowPrice);
        if (priceCents == null) {
          failed.push({ name, reason: "no readable price" });
          continue;
        }
        const currency = String(offer?.priceCurrency ?? "").toUpperCase();
        if (!currency) {
          failed.push({ name, reason: "the page does not say which currency the price is in" });
          continue;
        }
        if (!importableCurrency(currency)) {
          failed.push({ name, reason: unsupportedCurrencyReason(currency) });
          continue;
        }
        const availability = String(offer?.availability ?? "");
        const outOfStock = /outofstock|soldout|discontinued/i.test(availability);
        const { images } = clipImages(Array.isArray(node.image) ? node.image : node.image ? [node.image] : []);
        items.push({
          name,
          slug: slugify(name),
          priceCents,
          currency,
          sku: node.sku ? String(node.sku) : null,
          stock: 0,
          stockKnown: outOfStock,
          description: htmlToText(node.description ? String(node.description) : null),
          images,
          categoryName: node.category ? String(node.category) : null,
          source: "scrape",
          sourceId: null,
          sourceUrl:
            typeof node.url === "string" && /^https?:\/\//.test(node.url) ? node.url : pageUrl,
        });
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  });
  return { items, failed };
}

async function fromScrape(
  origin: string,
  startUrl: string,
): Promise<{ items: StagedProduct[]; failed: ImportResult["failed"] }> {
  const html = await fetchText(startUrl);
  if (!html) return { items: [], failed: [] };
  const first = productsFromJsonLd(html, startUrl);
  const found = [...first.items];
  const failed = [...first.failed];

  // follow a few same-origin product-looking links
  const $ = cheerio.load(html);
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const u = new URL(href, origin);
      if (u.origin === origin && /\/(products?|p)\//.test(u.pathname)) links.add(u.href);
    } catch {
      // ignore bad hrefs
    }
  });
  for (const link of [...links].slice(0, 8)) {
    const page = await fetchText(link);
    if (page) {
      const more = productsFromJsonLd(page, link);
      found.push(...more.items);
      failed.push(...more.failed);
    }
  }

  const seen = new Set<string>();
  const items = found
    .filter((p) => (seen.has(p.slug) ? false : (seen.add(p.slug), true)))
    .map((p, i) => ({ ...p, tempId: `imp_${i + 1}` }));
  return { items, failed };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export async function importFromUrl(rawUrl: string): Promise<ImportResult> {
  const url = await assertPublicUrl(rawUrl);
  const origin = url.origin;

  const shopifyFirst = await fetchJson(`${origin}/products.json?limit=250`);
  const shopifyProducts = (shopifyFirst as { products?: unknown } | null)?.products;
  if (Array.isArray(shopifyProducts) && shopifyProducts.length > 0) {
    const result = await importShopify(origin, shopifyFirst);
    if (result) return result;
  }

  const wooFirst = await fetchJson(`${origin}/wp-json/wc/store/v1/products?per_page=100`);
  if (Array.isArray(wooFirst) && wooFirst.length > 0) {
    const result = await importWoo(origin, wooFirst);
    if (result) return result;
  }

  const scraped = await fromScrape(origin, url.href);
  if (scraped.items.length > 0 || scraped.failed.length > 0) {
    return {
      source: "scrape",
      imported: scraped.items,
      categories: collectCategories(scraped.items),
      failed: scraped.failed,
      warnings: commonWarnings(scraped.items, []),
    };
  }

  return {
    source: "scrape",
    imported: [],
    categories: [],
    failed: [
      {
        url: rawUrl,
        reason:
          "No products found: not a Shopify /products.json or WooCommerce Store API site, and no Product JSON-LD on the page",
      },
    ],
    warnings: [],
  };
}
