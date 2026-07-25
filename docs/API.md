# Markii API Contract — v1

**Audience:** the frontend coding agent building `app/(dashboard)/`.
This document is the source of truth for every backend endpoint. The backend (API routes,
DB, importers, x402, generators) is owned separately — the frontend should **only** call
these endpoints, never touch `lib/db` or Drizzle directly.

- **Database:** Neon Postgres (serverless) via Drizzle. Requires `DATABASE_URL` in `.env.local`.
- **Auth:** none (single-tenant hackathon admin). All `/api/*` routes are open.
- **Base path:** all dashboard endpoints live under `/api/*` as Next.js route handlers.

---

## Conventions

- **Content type:** `application/json` for everything except CSV upload (`multipart/form-data`)
  and CSV export (`text/csv`).
- **IDs & slugs:** every entity has a numeric `id` and a string `slug`. Any path segment
  written as `:idOrSlug` accepts either (`/api/products/42` and `/api/products/blue-tee`
  both work). Slugs are unique per scope (site slugs globally; product/category slugs per site).
- **Scoping by-slug calls (important):** because product and category slugs are only unique
  *per site*, every by-slug request — reads **and** writes (`PATCH`, `DELETE`, `/duplicate`) —
  must pass `?siteId=`. Without it the API resolves an arbitrary same-slug row, which on a
  write silently edits another site's record. By-id calls need no `siteId`. Site endpoints
  are exempt (site slugs are globally unique).
- **Money:** integer cents (`priceCents: 1999` = $19.99). `currency` is ISO 4217 (`"USD"`).
  x402 balances are USDC on Base Sepolia, reported in cents-equivalent (6-decimal USDC
  normalized to cents) plus raw amount.
- **Dates:** ISO 8601 strings (`2026-07-24T18:00:00.000Z`). Date-range filters are
  `?from=` / `?to=` (ISO date or datetime; inclusive).
- **Pagination:** `?page=1&limit=20` (default `page=1`, `limit=20`, max `limit=100`).
  List responses are always:

  ```json
  { "items": [ ... ], "total": 123, "page": 1, "limit": 20 }
  ```

- **Search:** `?q=` does case-insensitive substring match on name/slug (and SKU for products).
- **Errors:** non-2xx responses are always:

  ```json
  { "error": { "code": "NOT_FOUND", "message": "Product not found" } }
  ```

  Codes: `VALIDATION_ERROR` (400, includes `details` array from zod), `NOT_FOUND` (404),
  `CONFLICT` (409, e.g. duplicate slug), `IMPORT_FAILED` (422), `INTERNAL` (500).
- **Mutations:** `POST` create → `201` with the created object. `PATCH` partial update →
  `200` with the updated object. `DELETE` → `200` with `{ "deleted": true, "id": 42 }`.
  All `PATCH` bodies are partial — send only the fields you're changing.

---

## Entities

### Site

```ts
{
  id: number,
  name: string,
  slug: string,                  // used as subdomain: {slug}.markii.app
  customDomain: string | null,
  status: "draft" | "live" | "paused",
  indexed: boolean,              // include in sitemap / allow crawler indexing
  agentDiscovery: boolean,       // serve llms.txt / agent.md
  purchasesEnabled: boolean,     // allow x402 checkout
  paymentProviders: { x402: boolean, stripe: boolean },
  walletAddress: string | null,  // receiving wallet for x402 (Base Sepolia)
  googleSiteVerification: string | null,
  productCount: number,          // computed, read-only
  categoryCount: number,         // computed, read-only
  storefrontUrl: string,         // computed, e.g. "https://demo-store.markii.app"
  createdAt: string,
  updatedAt: string
}
```

### Category

```ts
{
  id: number,
  siteId: number,
  parentId: number | null,       // non-null ⇒ this is a subcategory
  name: string,
  slug: string,
  description: string | null,
  imageUrl: string | null,
  enabled: boolean,
  productCount: number,          // computed, read-only
  site: { id, name, slug },      // included on detail responses
  parent: { id, name, slug } | null,
  children: [{ id, name, slug }],// subcategories, detail responses only
  createdAt: string,
  updatedAt: string
}
```

### Product

```ts
{
  id: number,
  siteId: number,
  categoryId: number | null,
  name: string,
  slug: string,
  description: string | null,
  priceCents: number,
  currency: string,              // default "USD"
  sku: string | null,
  stock: number,                 // 0 = out of stock
  images: string[],              // URLs (uploaded-file URLs or external links)
  enabled: boolean,
  suggestedProductIds: number[],
  addOns: [{ productId: number, mandatory: boolean }],
  site: { id, name, slug },      // detail responses only
  category: { id, name, slug, parentId } | null,
  suggestedProducts: [{ id, name, slug, priceCents, images }], // detail only
  createdAt: string,
  updatedAt: string
}
```

### Order (transaction)

```ts
{
  id: number,
  siteId: number,
  productId: number,
  quantity: number,
  status: "pending" | "success" | "cancel" | "failed",
  amountCents: number,
  currency: string,              // "USDC" for x402, "USD" for stripe
  provider: "x402" | "stripe",
  txHash: string | null,         // Base Sepolia tx hash for x402
  agent: {                       // who bought it (for the transaction popup)
    userAgent: string,           // e.g. "Claude-Agent/1.0"
    name: string,                // parsed friendly name, e.g. "Claude"
    walletAddress: string | null
  },
  product: { id, name, slug },   // included on list + detail
  site: { id, name, slug },
  createdAt: string
}
```

### TrafficEvent (analytics; read-only, written by the storefront layer)

```ts
{
  id: number,
  siteId: number,
  productId: number | null,
  path: string,                  // e.g. "/p/blue-tee", "/llms.txt"
  agentUserAgent: string,
  agentName: string,             // parsed: "Claude", "GPTBot", "PerplexityBot", "Other"
  createdAt: string
}
```

---

## 1. Dashboard overview

### `GET /api/overview`

One call powers the whole main dashboard grid.

```json
{
  "sites": { "total": 3, "live": 2, "draft": 1, "paused": 0 },
  "traffic": {
    "total": 1240,
    "last7d": 320,
    "byDay": [{ "date": "2026-07-18", "count": 40 }, ...],   // last 14 days
    "topAgents": [{ "agentName": "Claude", "count": 210 }, ...]
  },
  "finances": {
    "totalBalanceCents": 152300,
    "x402BalanceCents": 140000,
    "fiatBalanceCents": 12300,
    "orderCount": 87,
    "bySite": [
      { "siteId": 1, "siteName": "Demo Store", "siteSlug": "demo-store", "balanceCents": 90000 }
    ]
  }
}
```

---

## 2. Sites

### `GET /api/sites`
Query: `q`, `status` (`draft|live|paused`), `page`, `limit`, `sort` (`name|createdAt|-createdAt`).
Returns paginated list of **Site** (includes computed counts — enough to render the grid cards).

### `POST /api/sites`
Body (only `name` required; everything else defaults):

```json
{
  "name": "Demo Store",
  "slug": "demo-store",            // auto-generated from name if omitted
  "indexed": true,
  "agentDiscovery": true,
  "purchasesEnabled": true,
  "paymentProviders": { "x402": true, "stripe": false },
  "customDomain": null,
  "status": "draft"                // wizard's "save for later" = draft, "deploy" = live
}
```

→ `201` **Site**. `409 CONFLICT` if slug taken.

### `GET /api/sites/:idOrSlug`
→ **Site** (with counts and `storefrontUrl`).

### `PATCH /api/sites/:idOrSlug`
Any subset of the `POST` fields plus `status`, `walletAddress`, `googleSiteVerification`.
Use this for every toggle on the website slug page:

- pause/enable site → `{ "status": "paused" }` / `{ "status": "live" }`
- indexed toggle → `{ "indexed": false }`
- agent discovery / purchases → `{ "agentDiscovery": false }`, `{ "purchasesEnabled": false }`
- payment providers → `{ "paymentProviders": { "x402": true, "stripe": true } }`
- custom domain → `{ "customDomain": "shop.example.com" }`

→ `200` **Site**.

### `DELETE /api/sites/:idOrSlug`
Cascades: deletes the site's categories, products, and traffic; orders are kept (site
reference nulled) for financial history. → `{ "deleted": true, "id": 1 }`

### `GET /api/sites/:idOrSlug/summary`
Cards for the website slug page:

```json
{
  "traffic": { "total": 400, "last7d": 120, "byDay": [ ... ] },
  "purchases": { "count": 12, "last7d": 5 },
  "balance": { "totalCents": 90000, "x402Cents": 90000, "fiatCents": 0 }
}
```

### `POST /api/sites/:idOrSlug/deploy`
Marks the site `live` (and, when the Vercel domain integration lands, attaches the custom
domain). → `200` `{ "status": "live", "storefrontUrl": "https://demo-store.markii.app" }`

### Previews (create-site wizard live panes)

#### `POST /api/preview`
Stateless — works for **unsaved** wizard drafts. Send the draft site + products; get back
every preview pane in one shot. Re-call on change (debounce ~500 ms).

Body:

```json
{
  "site": { "name": "Demo Store", "slug": "demo-store", "indexed": true },
  "categories": [{ "name": "Shirts", "slug": "shirts" }],
  "products": [{ "name": "Blue Tee", "slug": "blue-tee", "priceCents": 1999,
                 "description": "…", "categorySlug": "shirts", "stock": 10,
                 "images": ["https://…/tee.jpg"] }]
}
```

Response:

```json
{
  "html": "<!doctype html>…",          // storefront landing HTML (render in sandboxed iframe via srcdoc)
  "llmsTxt": "# Demo Store\n…",
  "agentMd": "# Agent protocol\n…",
  "sitemap": {                          // non-technical tree for the sitemap pane
    "pages": [
      { "title": "Home", "path": "/" },
      { "title": "Shirts", "path": "/c/shirts", "children": [
        { "title": "Blue Tee", "path": "/p/blue-tee" } ] }
    ]
  },
  "jsonLd": { "@type": "Product", ... } // first product's JSON-LD, for the geeky pane if wanted
}
```

#### `GET /api/sites/:idOrSlug/preview`
Same response shape, generated from the **saved** site (edit flows).

### `GET /api/template`
Placeholder data for the wizard's "autofill from template" button. Returns exactly the
`POST /api/preview` body shape (site + categories + products with real-looking demo data).
Frontend drops it into the wizard state; nothing is saved until deploy/save.

---

## 3. Categories

### `GET /api/categories`
Query: `q`, `siteId`, `parentId` (`null` for top-level only), `enabled` (`true|false`),
`page`, `limit`. → paginated **Category** list (with `productCount`, `site`, `parent`).

### `POST /api/categories`
```json
{ "siteId": 1, "name": "Shirts", "slug": "shirts", "parentId": null,
  "description": null, "imageUrl": null, "enabled": true }
```
Only `siteId` + `name` required. → `201` **Category**.

### `GET /api/categories/:idOrSlug`
→ **Category** with `site`, `parent`, `children`, `productCount`.
(If slugs collide across sites, disambiguate with `?siteId=`.)

### `PATCH /api/categories/:idOrSlug`
Any subset. Covers the whole category slug page:

- reassign to another site → `{ "siteId": 2 }` (backend moves its products too)
- make it a subcategory → `{ "parentId": 5 }`; promote → `{ "parentId": null }`
- enable/disable → `{ "enabled": false }`

`400 VALIDATION_ERROR` if `parentId` would create a cycle or crosses sites.

### `DELETE /api/categories/:idOrSlug`
Products in it become uncategorized (`categoryId: null`); child categories are promoted to
top-level. → `{ "deleted": true, "id": 5 }`

### `POST /api/categories/:idOrSlug/duplicate`
Optional body: `{ "siteId": 2, "includeProducts": true }` (defaults: same site, products
duplicated too). New slug gets a `-copy` suffix. → `201` **Category**.

---

## 4. Products

### `GET /api/products`
Query: `q` (name/slug/SKU), `siteId`, `categoryId`, `enabled`, `inStock` (`true` ⇒ stock > 0),
`sort` (`name|priceCents|-priceCents|createdAt|-createdAt`), `page`, `limit`.
→ paginated **Product** list (includes `site` + `category` refs for the table).

The inventory page is this endpoint with no `siteId` filter; per-site product tabs pass `siteId`.

### `POST /api/products`
```json
{
  "siteId": 1, "name": "Blue Tee", "slug": "blue-tee",
  "categoryId": 3, "description": "Soft cotton tee",
  "priceCents": 1999, "currency": "USD",
  "sku": "TEE-BLU-M", "stock": 25,
  "images": ["https://…/tee.jpg"],
  "enabled": true,
  "suggestedProductIds": [7, 9],
  "addOns": [{ "productId": 11, "mandatory": false }]
}
```
Only `siteId`, `name`, `priceCents` required. → `201` **Product**.

### `GET /api/products/:idOrSlug`
→ **Product** with `site`, `category`, expanded `suggestedProducts`, and expanded add-on
products. (`?siteId=` to disambiguate slug collisions.)

### `PATCH /api/products/:idOrSlug`
Any subset — reassign category/site (`{ "categoryId": 4 }`, `{ "siteId": 2 }`), toggle
(`{ "enabled": false }`), stock/price edits, replace `images`, `suggestedProductIds`,
`addOns` (arrays are replaced wholesale, not merged). → `200` **Product**.
Reassigning `siteId` clears `categoryId` unless a valid `categoryId` on the target site is
sent in the same request.

### `DELETE /api/products/:idOrSlug`
Also removes it from other products' `suggestedProductIds`/`addOns`. → `{ "deleted": true }`

### `POST /api/products/:idOrSlug/duplicate`
Optional body: `{ "siteId": 2, "categoryId": 8 }`. Slug gets `-copy` suffix, SKU cleared,
stock copied. → `201` **Product**.

### `POST /api/uploads`
Image upload for the product form. `multipart/form-data` with field `file` (png/jpg/webp,
max 5 MB). → `201` `{ "url": "https://…" }` — put that URL into `images`.
Stored in Vercel Blob in production (local `public/uploads` in dev) — either way, treat
the returned `url` as opaque. (External image URLs can also be used directly without
uploading.)

---

## 5. Import (CSV / scrape popup)

Two-phase: **parse** (nothing saved) → user allocates in the UI → **commit**.

### `POST /api/import`
Either:
- `multipart/form-data` with `file` (CSV; header row required — recognized columns:
  `name, slug, description, price, currency, sku, stock, category, image_url` —
  `image_url` may be `|`-separated for multiple), **or**
- JSON `{ "url": "https://some-shop.com" }` — backend tries Shopify `/products.json`,
  then WooCommerce Store API, then sitemap/JSON-LD scrape.

Response (`200`, even with partial failures):

```json
{
  "source": "shopify",
  "imported": [
    { "tempId": "imp_1", "name": "Blue Tee", "slug": "blue-tee",
      "priceCents": 1999, "currency": "USD", "sku": "TEE-BLU-M", "stock": 25,
      "description": "…", "images": ["https://…"], "categoryName": "Shirts" }
  ],
  "categories": [ { "tempId": "cat_1", "name": "Shirts" } ],
  "failed": [ { "row": 7, "reason": "price is not a number" } ]
}
```

`422 IMPORT_FAILED` only if **nothing** could be parsed (bad CSV / unreachable URL /
unrecognized platform) — message explains why. Scrape URLs are SSRF-filtered: `localhost`,
`*.local`/`*.internal`, cloud-metadata hosts, and any hostname resolving to a private or
link-local address are rejected with `400 VALIDATION_ERROR`.

### `POST /api/import/commit`
The allocation step. Frontend sends where each staged item should land (drag-and-drop /
duplicate resolves to entries here — the same `tempId` may appear multiple times with
different `siteId`s to duplicate it into several sites):

```json
{
  "items": [ ...the "imported" array from /api/import (edited/pruned by the user)... ],
  "categories": [ ...the "categories" array... ],
  "allocations": [
    { "tempId": "imp_1", "siteId": 1, "categoryTempId": "cat_1" },
    { "tempId": "imp_1", "siteId": 2 },
    { "tempId": "cat_1", "siteId": 1, "parentCategoryId": 4 }
  ]
}
```

If an item names a `categoryTempId` that wasn't allocated to that item's `siteId`, the
category is created on the target site automatically (reusing a same-slug category there
if one exists) rather than rejecting the item — so you don't have to allocate every staged
category to every site its products land on.

→ `201`

```json
{ "createdProducts": [ Product, ... ], "createdCategories": [ Category, ... ],
  "failed": [ { "tempId": "imp_3", "reason": "duplicate slug on site 1" } ] }
```

---

## 6. Analytics

### `GET /api/analytics/overview`
Query: `q` (site name filter), `from`, `to` (default: last 28 days).

```json
{
  "total": 1240,
  "byDay": [{ "date": "2026-07-18", "count": 40 }],
  "byAgent": [{ "agentName": "Claude", "count": 210 }],
  "sites": [
    { "siteId": 1, "siteName": "Demo Store", "siteSlug": "demo-store",
      "total": 400, "last7d": 120, "topAgent": "Claude" }
  ]
}
```

### `GET /api/analytics/sites/:idOrSlug`
Query: `q` (product name filter), `from`, `to`, `page`, `limit` (paginates `products`).

```json
{
  "site": { "id": 1, "name": "Demo Store", "slug": "demo-store" },
  "total": 400,
  "byDay": [{ "date": "2026-07-18", "count": 12 }],
  "byAgent": [{ "agentName": "Claude", "count": 300 }],
  "products": {
    "items": [
      { "productId": 9, "name": "Blue Tee", "slug": "blue-tee", "views": 120,
        "agents": [{ "agentName": "Claude", "views": 90 }] }
    ],
    "total": 14, "page": 1, "limit": 20
  }
}
```

---

## 7. Finances

### `GET /api/finances/overview`
Query: `q` (site name), `from`, `to`.

```json
{
  "totalBalanceCents": 152300,
  "x402BalanceCents": 140000,
  "fiatBalanceCents": 12300,
  "orderCount": 87,
  "sites": [
    { "siteId": 1, "siteName": "Demo Store", "siteSlug": "demo-store",
      "balanceCents": 90000, "x402Cents": 90000, "fiatCents": 0,
      "orderCount": 40, "pendingCount": 2 }
  ]
}
```

### `GET /api/finances/sites/:idOrSlug`
Query: `status` (`pending|success|cancel|failed`), `q` (product name / tx hash),
`from`, `to`, `page`, `limit`.

```json
{
  "site": { "id": 1, "name": "Demo Store", "slug": "demo-store" },
  "balance": { "totalCents": 90000, "x402Cents": 90000, "fiatCents": 0 },
  "transactions": { "items": [ Order, ... ], "total": 40, "page": 1, "limit": 20 }
}
```

Each **Order** includes the `agent` object — the transaction-detail popup needs no extra
call, but `GET /api/orders/:id` exists if you want one.

### `GET /api/finances/sites/:idOrSlug/export`
Same filters as above. → `text/csv` download
(`Content-Disposition: attachment; filename="demo-store-transactions.csv"`).
Columns: `id,date,product,quantity,amount,currency,provider,status,tx_hash,agent`.

### `GET /api/orders/:id`
→ single **Order**.

---

## 8. Integrations

### `GET /api/integrations`

```json
{
  "x402": { "status": "connected", "walletAddress": "0xabc…", "network": "base-sepolia" },
  "google": { "status": "not_connected", "merchantId": null, "lastSyncAt": null },
  "stripe": { "status": "not_connected", "accountId": null }
}
```
`status`: `"connected" | "not_connected" | "error"` (with `"message"` when `error`).

### `PUT /api/integrations/x402`
`{ "walletAddress": "0x…" }` — default receiving wallet for new sites. → `200` status object.

### `PUT /api/integrations/google`
`{ "merchantId": "123456", "serviceAccountJson": "{…}" }` → `200` status object.
### `POST /api/integrations/google/sync` — push all live products to GMC. → `{ "synced": 42, "failed": 0 }`

### `PUT /api/integrations/stripe`
`{ "secretKey": "sk_test_…" }` → `200` status object. (Stripe is optional — build the UI,
expect `not_connected` in the demo.)

### `DELETE /api/integrations/:provider`
Disconnect. → `{ "status": "not_connected" }`

---

## 9. Storefront routes (FYI — do not build these)

Owned by the backend; listed so the frontend can link to them (e.g. "view live site",
preview tabs):

| URL (on the site's domain) | What it serves |
|---|---|
| `/` | server-rendered HTML catalog |
| `/c/{categorySlug}` | category page |
| `/p/{productSlug}` | product page + JSON-LD |
| `/llms.txt` | LLM-readable store summary |
| `/agent.md` | agent protocol + x402 purchase instructions |
| `/sitemap.xml` | sitemap |
| `/api/checkout` | x402 payment endpoint (402 challenge → settle) |

In local dev, storefronts are reachable at `http://localhost:3000/_sites/{siteSlug}/…`.

---

## Build-order notes for the frontend

Backend endpoints will land in this order (matching `docs/PLAN.md`); mock or defer screens
whose endpoints aren't up yet:

1. Sites, Products, Categories CRUD + `/api/overview` + `/api/template`
2. Import (parse + commit)
3. Preview endpoints (`/api/preview`)
4. Finances + orders (populated once x402 checkout works; seed data provided before that)
5. Analytics (seeded traffic data first, real agent logging after)
6. Integrations (x402 wallet real; Google/Stripe status-only)

Seed data (3 sites, ~30 products, categories, fake orders + traffic) ships with step 1 via
`pnpm db:seed`, so every list/analytics/finances screen renders non-empty from day one.
