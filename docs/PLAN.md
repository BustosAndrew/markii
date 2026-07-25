# Markii — Build Plan (4-hour hackathon)

Agent-native, multi-tenant e-commerce platform. Merchants import a catalog; Markii provisions
machine-readable storefronts (plain HTML + JSON-LD, `llms.txt`, `agent.md`) that AI agents can
crawl and buy from via the **x402** protocol (USDC on Base Sepolia).

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       NEXT.JS APP ROUTER                           │
├──────────────────────────────┬─────────────────────────────────────┤
│    Admin Dashboard           │       Multi-Tenant Stores           │
│    /(dashboard)/*            │   /_sites/[site]/* (via middleware) │
│  - Sites / Inventory         │  - Crawlable HTML + JSON-LD         │
│  - Analytics / Finances      │  - llms.txt & agent.md generators   │
│  - Integrations (GMC/Stripe) │  - x402 challenge & settlement      │
└──────────────────────────────┴─────────────────────────────────────┘
```

## Data model (Drizzle + Neon Postgres)

- **sites** — id, name, slug, subdomain, customDomain, indexed, agentDiscovery, purchasesEnabled,
  paused, paymentProviders (x402/stripe flags), walletAddress, googleSiteVerification
- **categories** — id, siteId, parentId (nullable → subcategories), name, slug, enabled, imageUrl
- **products** — id, siteId, categoryId, name, slug, description, priceCents, currency, sku, stock,
  images (jsonb), enabled, suggestedProductIds (jsonb), addOns (jsonb: {productId, mandatory})
- **orders** — id, siteId, productId, status (pending/success/cancel/failed), amount, asset, txHash,
  agentIdentifier, createdAt
- **agent_traffic** — id, siteId, productId (nullable), agentUserAgent, path, createdAt

## Route map

### Dashboard (`app/(dashboard)/`) — from the frontend spec

| Route | Contents |
|---|---|
| `/dashboard` | Grid: site count, agent-traffic card, total balance (x402/fiat), create-site card |
| `/dashboard/inventory` | All products/categories, search + filters, CSV/scrape popup, create product/category |
| `/dashboard/categories` | All categories, search + filters |
| `/dashboard/categories/[slug]` | Details, reassign site/parent, make subcategory, enable/disable, duplicate |
| `/dashboard/products/[slug]` | Details (images, pricing, sku, stock), reassign, enable/disable, duplicate, suggested products, add-ons |
| `/dashboard/websites` | Grid of sites, search + filters, create card |
| `/dashboard/websites/new` | Multi-step wizard: import/manual products → site name → live previews (HTML, llms.txt/agent.md, sitemap) → indexing toggle → custom domain → deploy/save. "Autofill from template" button with placeholder data |
| `/dashboard/websites/[slug]` | Edit, agent discovery/purchase toggles, traffic + purchases + balance cards, pause confirm, payment provider toggles, domain |
| `/dashboard/analytics` | Search-console-style overview, all sites, search/date filters |
| `/dashboard/analytics/[slug]` | Per-site traffic; products viewed and by which agent |
| `/dashboard/finances` | Total balance across sites, search/date filters |
| `/dashboard/finances/[slug]` | Per-site balance, transactions (success/cancel/pending/failed), agent popup, export |
| `/dashboard/integrations` | Google Merchant Center + Stripe (optional) setup/status, x402 wallet |

### Storefronts (`app/_sites/[site]/`)

- `page.tsx` — clean HTML catalog landing (server-rendered, no client JS)
- `p/[productSlug]/page.tsx` — HTML + `<script type="application/ld+json">` (Schema.org Product/Offer),
  merchant Google verification meta tag, `Cache-Control: public, max-age=3600, s-maxage=86400`
- `llms.txt/route.ts` — plaintext store overview for LLMs
- `agent.md/route.ts` — machine protocol + x402 payment rules
- `sitemap.xml/route.ts` — product/category URLs
- `api/checkout/route.ts` — x402: 402 challenge → verify signature/tx via viem → decrement stock → 200 + fulfillment JSON

### Middleware (`middleware.ts`)

Host-header multi-tenancy: `app.*` → dashboard; otherwise resolve host → siteId (DB/cache) and
rewrite to `/_sites/[siteId]/...`.

## Key modules (`lib/`)

- `db/schema.ts`, `db/index.ts` — Drizzle + `@neondatabase/serverless`
- `importer.ts` — Shopify `/products.json` → Woo `wp-json/wc/store/v1/products` → cheerio sitemap/JSON-LD fallback; CSV parser. All wrapped in try/catch with graceful fallback
- `x402.ts` — challenge builder + settlement verification (`@x402/core`, viem)
- `generators.ts` — llms.txt / agent.md / JSON-LD (typed with `schema-dts`, validated with zod)
- `vercel.ts` — custom domain add + CNAME status via `@vercel/sdk`
- `google-merchant.ts` — GMC Content API product sync (`googleapis`)
- `stripe.ts` — **optional** fiat checkout alternative (planned, not in core path)

## Timeline (4 hours)

**Hour 0 — DONE**
- Scaffold (Next 16, Tailwind 4, pnpm), all deps installed, brand + animated landing page

**Hour 1 — Data + dashboard shell**
- Drizzle schema + Neon connection, seed script with demo data
- `(dashboard)` layout (sidebar nav), dashboard overview grid with real counts

**Hour 2 — Inventory + import**
- Inventory/products/categories list pages with search/filters
- CSV/scrape popup → Shopify importer (primary strategy only), allocation step
- Product + category slug pages (view/edit/enable/duplicate)

**Hour 3 — Storefront + x402 (the demo wow)**
- `_sites` renderer: catalog page, product page with JSON-LD, llms.txt, agent.md, sitemap
- Middleware host routing
- x402 checkout route: 402 challenge + viem verification; record orders

**Hour 4 — Wire the story together**
- Websites list + create-site wizard (import → name → live previews → deploy) with template autofill
- Website slug page toggles; finances page from orders table
- Deploy to Vercel, end-to-end demo script (agent fetch → 402 → pay → 200)

**Save for last (stretch, in order)**
1. Analytics pages (log agent user-agents into `agent_traffic`, chart)
2. Custom domains via `@vercel/sdk`
3. WooCommerce + cheerio fallback importers
4. Google Merchant Center sync
5. Stripe integration (optional; UI stub on integrations page first)
6. Suggested products / add-ons, drag-and-drop import allocation

## Execution rules

- Storefront pages stay **server-rendered, minimal HTML** — no `"use client"` under `_sites/`
- Validate all product input with **zod** before generating HTML/JSON-LD
- Import routines: try/catch every fetch, fall back per strategy chain
- Dashboard can be client-rich; storefronts cannot
