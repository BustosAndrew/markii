import type { Product as SchemaProduct, WithContext } from "schema-dts";
import { slugify, tenantBaseUrl } from "@/lib/api";
import type { Category, Product, Site } from "@/lib/db";
import { getTheme, themeDocumentStylesheet } from "@/lib/storefront/themes";

/**
 * A site + catalog snapshot every generator works from. Built either from the DB
 * (saved sites) or from the create-site wizard's draft payload (unsaved).
 */
export type ThemeId = "studio" | "atlas" | "noir" | "bloom";

export type Bundle = {
  site: {
    name: string;
    slug: string;
    description?: string | null;
    indexed?: boolean;
    themeId?: ThemeId;
    googleSiteVerification?: string | null;
  };
  categories: {
    name: string;
    slug: string;
    parentSlug?: string | null;
    description?: string | null;
  }[];
  products: {
    name: string;
    slug: string;
    priceCents: number;
    currency: string;
    description?: string | null;
    categorySlug?: string | null;
    sku?: string | null;
    stock: number;
    images: string[];
  }[];
};

export function bundleFromDb(site: Site, cats: Category[], prods: Product[]): Bundle {
  const catById = new Map(cats.map((c) => [c.id, c]));
  return {
    site: {
      name: site.name,
      slug: site.slug,
      indexed: site.indexed,
      themeId: (site.themeId as ThemeId | undefined) ?? "studio",
      googleSiteVerification: site.googleSiteVerification,
    },
    categories: cats
      .filter((c) => c.enabled)
      .map((c) => ({
        name: c.name,
        slug: c.slug,
        parentSlug: c.parentId != null ? (catById.get(c.parentId)?.slug ?? null) : null,
        description: c.description,
      })),
    products: prods
      .filter((p) => p.enabled)
      .map((p) => ({
        name: p.name,
        slug: p.slug,
        priceCents: p.priceCents,
        currency: p.currency,
        description: p.description,
        categorySlug: p.categoryId != null ? (catById.get(p.categoryId)?.slug ?? null) : null,
        sku: p.sku,
        stock: p.stock,
        images: p.images,
      })),
  };
}

export function formatPrice(cents: number, currency: string): string {
  const value = (cents / 100).toFixed(2);
  return currency === "USD" || currency === "USDC" ? `$${value}` : `${value} ${currency}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const strip = (s: string | null | undefined) =>
  (s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

// ---------- llms.txt ----------

export type AgentDiscoveryOpts = {
  payTo?: string | null;
  /** Which purchase rails this store actually offers. */
  rails?: { x402?: boolean; stripe?: boolean };
  purchasesEnabled?: boolean;
};

function discoveryBlurb(opts: AgentDiscoveryOpts): string {
  const rails: string[] = [];
  if (opts.rails?.x402) rails.push("x402 (USDC)");
  if (opts.rails?.stripe) rails.push("card via Stripe");
  if (rails.length === 0) {
    return "Every product page is plain HTML with Schema.org JSON-LD for agents and crawlers.";
  }
  return `Every product page is plain HTML with Schema.org JSON-LD. Purchases settle over ${rails.join(" or ")}.`;
}

export function generateLlmsTxt(
  bundle: Bundle,
  baseUrl: string,
  opts: AgentDiscoveryOpts = {},
): string {
  const { site, products, categories } = bundle;
  const lines: string[] = [
    `# ${site.name}`,
    "",
    site.description?.trim() || `${site.name} is an agent-readable store. ${discoveryBlurb(opts)}`,
    "",
    `- Store: ${baseUrl}/`,
    `- Agent protocol: ${baseUrl}/agent.md`,
    `- Sitemap: ${baseUrl}/sitemap.xml`,
  ];
  if (opts.purchasesEnabled !== false && opts.rails?.x402) {
    lines.push(`- Checkout API: POST ${baseUrl}/api/checkout`);
  }
  lines.push("");
  if (categories.length) {
    lines.push("## Categories", "");
    for (const c of categories) {
      lines.push(`- [${c.name}](${baseUrl}/c/${c.slug})${c.description ? `: ${strip(c.description)}` : ""}`);
    }
    lines.push("");
  }
  lines.push("## Products", "");
  for (const p of products) {
    const desc = strip(p.description).slice(0, 160);
    lines.push(
      `- [${p.name}](${baseUrl}/p/${p.slug}) — ${formatPrice(p.priceCents, p.currency)}${
        p.stock > 0 ? ` (${p.stock} in stock)` : " (out of stock)"
      }${desc ? ` — ${desc}` : ""}`,
    );
  }
  return lines.join("\n") + "\n";
}

// ---------- agent.md ----------

export function generateAgentMd(
  bundle: Bundle,
  baseUrl: string,
  opts: AgentDiscoveryOpts = {},
): string {
  const { site, products } = bundle;
  const x402On = opts.purchasesEnabled !== false && opts.rails?.x402;
  const purchaseSection = x402On
    ? `## Purchase (x402 / USDC)

1. \`POST ${baseUrl}/api/checkout\` with JSON body \`{ "productSlug": "...", "quantity": 1 }\`.
2. Without payment you receive \`402 Payment Required\` with an \`accepts\` array:
   scheme \`exact\`, network \`base-sepolia\`, asset USDC
   (\`0x036CbD53842c5426634e7929541eC2318f3dCF7e\`), \`payTo\` ${opts.payTo ?? "(store wallet)"} and
   \`maxAmountRequired\` in USDC base units (6 decimals).
3. Transfer the exact USDC amount to \`payTo\` on Base Sepolia.
4. Retry the same request with header
   \`X-PAYMENT: base64({"txHash":"0x...","from":"0x..."})\`.
5. On verification you receive \`200\` with a fulfillment receipt and the order id.
`
    : `## Purchase

Agent checkout is not enabled for this store right now. Catalog pages remain readable.
`;

  return `# ${site.name} — agent protocol

This store is machine-readable. ${discoveryBlurb(opts)}

## Discover

- \`GET ${baseUrl}/llms.txt\` — catalog summary
- \`GET ${baseUrl}/sitemap.xml\` — all URLs
- Every product page (\`${baseUrl}/p/{slug}\`) embeds Schema.org Product JSON-LD.

${purchaseSection}
## Catalog

${products
  .map((p) => `- \`${p.slug}\` — ${p.name} — ${formatPrice(p.priceCents, p.currency)} — stock ${p.stock}`)
  .join("\n")}
`;
}

// ---------- JSON-LD ----------

export function productJsonLd(
  bundle: Bundle,
  product: Bundle["products"][number],
  baseUrl: string,
): WithContext<SchemaProduct> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: strip(product.description) || undefined,
    image: product.images.length ? product.images : undefined,
    sku: product.sku ?? undefined,
    url: `${baseUrl}/p/${product.slug}`,
    offers: {
      "@type": "Offer",
      price: (product.priceCents / 100).toFixed(2),
      priceCurrency: product.currency,
      availability:
        product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: `${baseUrl}/p/${product.slug}`,
      seller: { "@type": "Organization", name: bundle.site.name },
    },
  };
}

// ---------- sitemap ----------

export type SitemapNode = { title: string; path: string; children?: SitemapNode[] };

export function sitemapTree(bundle: Bundle): { pages: SitemapNode[] } {
  const topCats = bundle.categories.filter((c) => !c.parentSlug);
  const childCats = (parent: string) => bundle.categories.filter((c) => c.parentSlug === parent);
  const productNodes = (categorySlug: string | null) =>
    bundle.products
      .filter((p) => (p.categorySlug ?? null) === categorySlug)
      .map((p) => ({ title: p.name, path: `/p/${p.slug}` }));

  const catNode = (c: Bundle["categories"][number]): SitemapNode => ({
    title: c.name,
    path: `/c/${c.slug}`,
    children: [...childCats(c.slug).map(catNode), ...productNodes(c.slug)],
  });

  return {
    pages: [
      { title: "Home", path: "/" },
      ...topCats.map(catNode),
      ...productNodes(null),
    ],
  };
}

export function generateSitemapXml(bundle: Bundle, baseUrl: string): string {
  const urls = [
    `${baseUrl}/`,
    ...bundle.categories.map((c) => `${baseUrl}/c/${c.slug}`),
    ...bundle.products.map((p) => `${baseUrl}/p/${p.slug}`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join("\n")}
</urlset>
`;
}

// ---------- crawler-friendly HTML (storefront landing / preview) ----------

export function generateStorefrontHtml(bundle: Bundle, baseUrl: string): string {
  const { site, categories, products } = bundle;
  const theme = getTheme(site.themeId);
  const nav = categories
    .filter((c) => !c.parentSlug)
    .map(
      (c) =>
        `<a href="${baseUrl}/c/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`,
    )
    .join("");
  const cards = products
    .map(
      (p) => `<li><a class="sf-card" href="${baseUrl}/p/${escapeHtml(p.slug)}">
${p.images[0] ? `<img src="${escapeHtml(p.images[0])}" alt="${escapeHtml(p.name)}" loading="lazy">` : ""}
<h2>${escapeHtml(p.name)}</h2>
<p class="sf-price">${formatPrice(p.priceCents, p.currency)}</p>
<p class="sf-muted">${p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}</p>
</a></li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(site.name)}</title>
${site.indexed === false ? `<meta name="robots" content="noindex">` : ""}
${site.googleSiteVerification ? `<meta name="google-site-verification" content="${escapeHtml(site.googleSiteVerification)}">` : ""}
<meta name="description" content="${escapeHtml(strip(site.description) || `${site.name} — agent-friendly store`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${escapeHtml(theme.fontHref)}">
<style>${themeDocumentStylesheet(theme)}</style>
</head>
<body>
<div class="sf-shell" data-theme="${theme.id}">
<header class="sf-header"><div class="sf-header-inner">
<a class="sf-brand" href="${baseUrl}/">${escapeHtml(site.name)}</a>
<nav class="sf-nav">${nav}</nav>
</div></header>
<main class="sf-main">
<header class="sf-hero">
<h1 class="sf-title">${escapeHtml(site.name)}</h1>
<p class="sf-lede">Agent-readable store — see <a href="${baseUrl}/llms.txt">llms.txt</a> and <a href="${baseUrl}/agent.md">agent.md</a>.</p>
</header>
<ul class="sf-grid">
${cards}
</ul>
</main>
</div>
</body>
</html>`;
}

/** Everything the create-site wizard's live preview panes need, in one object. */
export function generatePreview(bundle: Bundle) {
  const slug = bundle.site.slug || slugify(bundle.site.name);
  const withSlug: Bundle = { ...bundle, site: { ...bundle.site, slug } };
  const baseUrl = tenantBaseUrl(slug);
  return {
    html: generateStorefrontHtml(withSlug, baseUrl),
    llmsTxt: generateLlmsTxt(withSlug, baseUrl),
    agentMd: generateAgentMd(withSlug, baseUrl),
    sitemap: sitemapTree(withSlug),
    jsonLd: withSlug.products[0]
      ? productJsonLd(withSlug, withSlug.products[0], baseUrl)
      : null,
  };
}
