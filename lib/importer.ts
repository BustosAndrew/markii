import { lookup } from "node:dns/promises";
import * as cheerio from "cheerio";
import { badRequest, slugify } from "@/lib/api";

export type StagedProduct = {
  tempId: string;
  name: string;
  slug: string;
  priceCents: number;
  currency: string;
  sku: string | null;
  stock: number;
  description: string | null;
  images: string[];
  categoryName: string | null;
};

export type ImportResult = {
  source: "csv" | "shopify" | "woocommerce" | "scrape";
  imported: StagedProduct[];
  categories: { tempId: string; name: string }[];
  failed: { row?: number; url?: string; reason: string }[];
};

const toCents = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

function collectCategories(items: StagedProduct[]): { tempId: string; name: string }[] {
  const names = [...new Set(items.map((i) => i.categoryName).filter((n): n is string => !!n))];
  return names.map((name, i) => ({ tempId: `cat_${i + 1}`, name }));
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

export function importFromCsv(text: string): ImportResult {
  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    return {
      source: "csv",
      imported: [],
      categories: [],
      failed: [{ reason: "CSV needs a header row and at least one data row" }],
    };
  }
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (row: string[], name: string): string => {
    const i = header.indexOf(name);
    return i >= 0 ? (row[i] ?? "").trim() : "";
  };
  if (!header.includes("name")) {
    return {
      source: "csv",
      imported: [],
      categories: [],
      failed: [{ reason: `CSV header must include a "name" column (got: ${header.join(", ")})` }],
    };
  }

  const imported: StagedProduct[] = [];
  const failed: ImportResult["failed"] = [];
  rows.slice(1).forEach((row, idx) => {
    const rowNum = idx + 2; // 1-based, after header
    const name = col(row, "name");
    if (!name) {
      failed.push({ row: rowNum, reason: "missing name" });
      return;
    }
    const priceCents = toCents(col(row, "price"));
    if (priceCents == null) {
      failed.push({ row: rowNum, reason: "price is not a number" });
      return;
    }
    imported.push({
      tempId: `imp_${imported.length + 1}`,
      name,
      slug: col(row, "slug") ? slugify(col(row, "slug")) : slugify(name),
      priceCents,
      currency: (col(row, "currency") || "USD").toUpperCase().slice(0, 3),
      sku: col(row, "sku") || null,
      stock: parseInt(col(row, "stock"), 10) || 0,
      description: col(row, "description") || null,
      images: col(row, "image_url")
        ? col(row, "image_url").split("|").map((s) => s.trim()).filter(Boolean)
        : [],
      categoryName: col(row, "category") || null,
    });
  });
  return { source: "csv", imported, categories: collectCategories(imported), failed };
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

// ---------- URL scrape: Shopify → WooCommerce → JSON-LD ----------

const FETCH_HEADERS = { "user-agent": "Markii-Importer/1.0 (+https://markii.app)" };

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function fromShopify(data: any): StagedProduct[] {
  const out: StagedProduct[] = [];
  for (const p of data?.products ?? []) {
    const variant = p.variants?.[0];
    const priceCents = toCents(variant?.price);
    if (!p.title || priceCents == null) continue;
    out.push({
      tempId: `imp_${out.length + 1}`,
      name: p.title,
      slug: slugify(p.handle || p.title),
      priceCents,
      currency: "USD",
      sku: variant?.sku || null,
      stock: Math.max(0, variant?.inventory_quantity ?? 10),
      description: p.body_html || null,
      images: (p.images ?? []).map((i: any) => i.src).filter(Boolean).slice(0, 10),
      categoryName: p.product_type || null,
    });
  }
  return out;
}

function fromWoo(data: any): StagedProduct[] {
  const out: StagedProduct[] = [];
  if (!Array.isArray(data)) return out;
  for (const p of data) {
    const minorUnit = p.prices?.currency_minor_unit ?? 2;
    const raw = parseInt(p.prices?.price ?? "", 10);
    if (!p.name || !Number.isFinite(raw)) continue;
    const priceCents = Math.round(raw * Math.pow(10, 2 - minorUnit));
    out.push({
      tempId: `imp_${out.length + 1}`,
      name: p.name,
      slug: slugify(p.slug || p.name),
      priceCents,
      currency: (p.prices?.currency_code || "USD").toUpperCase(),
      sku: p.sku || null,
      stock: p.is_in_stock === false ? 0 : 10,
      description: p.description || p.short_description || null,
      images: (p.images ?? []).map((i: any) => i.src).filter(Boolean).slice(0, 10),
      categoryName: p.categories?.[0]?.name ?? null,
    });
  }
  return out;
}

function productsFromJsonLd(html: string): Omit<StagedProduct, "tempId">[] {
  const $ = cheerio.load(html);
  const out: Omit<StagedProduct, "tempId">[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed["@graph"] ?? [])];
      for (const node of nodes) {
        if (node?.["@type"] !== "Product" && !(Array.isArray(node?.["@type"]) && node["@type"].includes("Product")))
          continue;
        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const priceCents = toCents(offer?.price ?? offer?.lowPrice);
        if (!node.name || priceCents == null) continue;
        out.push({
          name: String(node.name),
          slug: slugify(String(node.name)),
          priceCents,
          currency: (offer?.priceCurrency || "USD").toUpperCase(),
          sku: node.sku ? String(node.sku) : null,
          stock: /outofstock/i.test(String(offer?.availability ?? "")) ? 0 : 10,
          description: node.description ? String(node.description) : null,
          images: (Array.isArray(node.image) ? node.image : node.image ? [node.image] : [])
            .map(String)
            .slice(0, 10),
          categoryName: node.category ? String(node.category) : null,
        });
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  });
  return out;
}

async function fromScrape(origin: string, startUrl: string): Promise<StagedProduct[]> {
  const html = await fetchText(startUrl);
  if (!html) return [];
  const found = [...productsFromJsonLd(html)];

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
    if (page) found.push(...productsFromJsonLd(page));
  }

  const seen = new Set<string>();
  return found
    .filter((p) => (seen.has(p.slug) ? false : (seen.add(p.slug), true)))
    .map((p, i) => ({ ...p, tempId: `imp_${i + 1}` }));
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export async function importFromUrl(rawUrl: string): Promise<ImportResult> {
  // Note: redirects are still followed, so a public host that 302s into private
  // space remains a residual vector; the direct-address case is closed here.
  const url = await assertPublicUrl(rawUrl);
  const origin = url.origin;

  const shopify = await fetchJson(`${origin}/products.json?limit=250`);
  const shopifyItems = shopify ? fromShopify(shopify) : [];
  if (shopifyItems.length > 0) {
    return {
      source: "shopify",
      imported: shopifyItems,
      categories: collectCategories(shopifyItems),
      failed: [],
    };
  }

  const woo = await fetchJson(`${origin}/wp-json/wc/store/v1/products?per_page=100`);
  const wooItems = woo ? fromWoo(woo) : [];
  if (wooItems.length > 0) {
    return {
      source: "woocommerce",
      imported: wooItems,
      categories: collectCategories(wooItems),
      failed: [],
    };
  }

  const scraped = await fromScrape(origin, url.href);
  if (scraped.length > 0) {
    return { source: "scrape", imported: scraped, categories: collectCategories(scraped), failed: [] };
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
  };
}
