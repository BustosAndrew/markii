# Markii API Contract — v2

**Audience:** the frontend coding agent building `app/(dashboard)/`.
This document is the source of truth for every backend endpoint. The backend (API routes,
DB, importers, x402, generators) is owned separately — the frontend should **only** call
these endpoints, never touch `lib/db` or Drizzle directly.

- **Database:** Postgres via Drizzle, hosted on **Supabase** (which also provides auth and file
  storage). Requires `DATABASE_URL` in `.env.local`. Migration from Neon is a driver swap with the
  schema unchanged — `docs/DECISIONS.md` §D6.
- **Auth:** none (single-tenant hackathon admin). All `/api/*` routes are open. The role model in
  §15 is a **UI construct only** — nothing is enforced server-side yet.
- **Base path:** all dashboard endpoints live under `/api/*` as Next.js route handlers.

## Status legend

Markii is a full commerce platform (`docs/PLAN.md` v3); the AI-legibility layer is its
differentiator rather than its whole scope. Sections
carry an explicit status — **never call a `PLANNED` endpoint and never fake its response**:

| Badge | Meaning |
|---|---|
| ✅ **LIVE** | Implemented in `app/api/*` today. Call it. |
| 🟡 **PLANNED** | Contract agreed, route not built. Frontend defines the typed service; screens show *configuration required* / *not yet measured* until it lands. |

| § | Area | Status | Phase |
|---|---|---|---|
| 1–8 | Overview, sites, categories, products, import, analytics, finances, integrations | ✅ LIVE | — |
| 9 | Readiness & catalog health | ✅ LIVE — rule-based, deterministic, no model inference. Issues recomputed per request; only merchant decisions and daily score snapshots persist | **C** |
| 10 | Channels | 🟡 PLANNED | E |
| 11 | Product agent-data extension | 🟡 PLANNED | E |
| 12 | Agent Test Lab | 🟡 PLANNED | E |
| 13 | Orders (promoted) | ✅ LIVE — list, export, `GET /api/orders/:id` (lines, refunds, fulfillments, timeline), and the §18.7 order actions. The extended entity's speculative fields are not built | C |
| 14 | Analytics v2 (funnel, channels, failures) | 🟡 PLANNED | E |
| 15 | Automations, activity, notifications, team | 🟡 PLANNED | E |
| 16 | Accounts, organizations, staff | partial — `/api/auth/*`, `/api/me`, `/api/org`, `/api/org/staff*`, `/api/org/tokens*`, `/api/org/switch`, and **org scoping of §1–8** are ✅ LIVE; **audit, sessions, and MFA** remain PLANNED. (Tokens and org switching were listed as planned here until 2026-08-03; both were already routed.) Frontend: `/dashboard/settings/team` and the sidebar org switcher | **A** |
| 17 | Billing, plans, metering, threshold fees | partial — ✅ LIVE: usage ledger, threshold fee engine, meter, plan catalog, entitlements, period-close assessments, and the **Stripe webhook** (verified + idempotent, no handlers yet). 🟡 Stripe-dependent routes (subscription changes, payment method, invoices) refuse with 503 CONFIGURATION_REQUIRED; **nothing is charged** | B |
| 18 | Commerce core (variants, inventory, collections, customers, cart, checkout, discounts, tax, shipping, **memberships**) | partial — §18.1–18.6 ✅ LIVE **except** the §18.4 card rail and §18.6 Stripe Tax; §18.5 gift cards are ⛔ **deferred** (D33). §18.7 order operations, §18.8 digital delivery, and §18.9 membership gating + shopper login ✅ LIVE, **except** processor-executed refunds (Markii records a refund and meters it; the merchant moves the money) and recurring/auto-renewing membership billing | C |
| 19 | Site builder & content | 🟡 PLANNED | D |
| 20 | Disputes & chargebacks | 🟡 PLANNED | F |
| 21 | Agent Ops add-on | 🟡 PLANNED | F (last) |
| 22 | **Action registry & MCP** — agent-native architecture | ✅ LIVE (registry, invoke, dry-run, audit). Undo + MCP server PLANNED | **Registry: C · MCP: D** |
| 24 | Email — sending domains, deliverability, suppression | partial — ✅ LIVE: SES transport, templates, suppression list, bounce webhook, `/api/settings/email`, §22 actions. **Nothing sends here** (no AWS credentials); every attempt is recorded as `not_configured` and merchant mail never falls back to Markii's domain | **C** |

**v3 note.** Markii is now a full commerce platform (`docs/PLAN.md` v3). §16 was a **breaking change
to everything above it**, and as of 2026-07-31 that change has landed: **every `/api/*` route
except `/api/auth/*` now requires a session and is org-scoped**. Unauthenticated calls get `401`;
rows belonging to another org get `404`. Response shapes are unchanged.

**Payment-rail neutrality.** x402/USDC is **one rail among several** (card, Stripe, PayPal,
external processor), not the product identity. Anywhere a payment appears, the rail is a labeled
field — never an assumption.

**No mock data.** Do not add fixtures or mock route handlers for PLANNED areas. Ship real
loading/empty/error states instead. If fixtures are introduced later they sit behind a global Demo
Mode flag with a persistent indicator, and must never be presented as production results.

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
- **Minor units are currency-defined (D31).** New fields carry a `Minor` suffix and their exponent
  comes from the currency, not from a constant: USD has 2 decimals, **JPY and KRW have 0**, BHD and
  KWD have 3. Any formatter that hardcodes `/100` or forces two fraction digits renders JPY 100×
  wrong. Derive it — `Intl.NumberFormat(locale, { style: "currency", currency })` already knows the
  exponent when you don't override `minimumFractionDigits`. The legacy `Cents` fields in §1–8 stay
  as they are and remain USD-shaped; the rule binds everything from §16 onward, where
  `Organization.currency` is merchant-set.
- **Dates:** ISO 8601 strings (`2026-07-24T18:00:00.000Z`). Date-range filters are
  `?from=` / `?to=` (ISO date or datetime; inclusive).
- **Pagination:** `?page=1&limit=20` (default `page=1`, `limit=20`, max `limit=100`).
  List responses are always:

  ```json
  { "items": [ ... ], "total": 123, "page": 1, "limit": 20 }
  ```

- **Search:** `?q=` does case-insensitive substring match on name/slug (and SKU for products).
- **Environment:** `?environment=test|production` (default: both) on every analytics, channel,
  order, and overview read. Responses echo `"environment"` on any object that has one so the UI
  can badge it. Test/sandbox data must never be silently summed into production totals.
- **Data provenance:** any response containing numbers that are not production-sourced carries
  `"dataSource": "production" | "test" | "demo"` at the top level. The UI labels anything that
  isn't `"production"`.
- **Errors:** non-2xx responses are always:

  ```json
  { "error": { "code": "NOT_FOUND", "message": "Product not found" } }
  ```

  Codes: `VALIDATION_ERROR` (400, includes `details` array from zod), `UNAUTHORIZED` (401,
  no session), `FORBIDDEN` (403, session lacks the permission), `NOT_FOUND` (404),
  `CONFLICT` (409, e.g. duplicate slug), `IMPORT_FAILED` (422), `INTERNAL` (500).
  `UNAUTHORIZED` and `FORBIDDEN` exist in the envelope from now on but are only *returned*
  once §16 lands — today no route authenticates. The distinction matters to the UI:
  401 means "sign in", 403 means "signing in again will not help".
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
  slug: string,                  // used as subdomain: {slug}.markii.shop
  customDomain: string | null,
  status: "draft" | "live" | "paused",
  themeId: "studio" | "atlas" | "noir" | "bloom", // launch storefront theme; default "studio"
  indexed: boolean,              // include in sitemap / allow crawler indexing
  agentDiscovery: boolean,       // serve llms.txt / agent.md
  purchasesEnabled: boolean,     // allow x402 checkout
  paymentProviders: { x402: boolean, stripe: boolean },
  walletAddress: string | null,  // receiving wallet for x402 (Base Sepolia)
  googleSiteVerification: string | null,
  productCount: number,          // computed, read-only
  categoryCount: number,         // computed, read-only
  storefrontUrl: string,         // computed, e.g. "https://demo-store.markii.shop"
  createdAt: string,
  updatedAt: string
}
```

Launch themes (`studio` · `atlas` · `noir` · `bloom`) are applied by the fixed renderer in
`app/%5Fsites/`. They are **not** Phase D builder themes (`/api/themes` stays 🟡 PLANNED).

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
  "themeId": "studio",             // studio | atlas | noir | bloom; default studio
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
Any subset of the `POST` fields plus `status`, `walletAddress`, `googleSiteVerification`,
`themeId`. Use this for every toggle on the website slug page:

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
domain). → `200` `{ "status": "live", "storefrontUrl": "https://demo-store.markii.shop" }`

### Previews (create-site wizard live panes)

#### `POST /api/preview`
Stateless — works for **unsaved** wizard drafts. Send the draft site + products; get back
every preview pane in one shot. Re-call on change (debounce ~500 ms).

Body:

```json
{
  "site": { "name": "Demo Store", "slug": "demo-store", "indexed": true, "themeId": "studio" },
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
Stored in **Supabase Storage**, `public-media` bucket, in every environment — the local-filesystem
fallback is gone. It wrote `public/uploads` whenever `BLOB_READ_WRITE_TOKEN` was unset, which looked
like success and 404'd as soon as a Vercel instance recycled; an unconfigured deployment now returns
`503 CONFIGURATION_REQUIRED` instead of a URL that will not resolve. Treat the returned `url` as
**opaque** — that rule is why this swap needed no frontend edit. Images are public by design: they
appear in storefront HTML and JSON-LD, so a signed URL would expire out of a cached page. Files a
merchant *sells* go to a private bucket instead (§18.8). (External image URLs can also be used
directly without uploading.)
Superseded by `/api/media` (§19) once the media library lands.

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
`{ "secretKey": "sk_test_…" }` → `200` status object.

**v3 note (`docs/DECISIONS.md` §D4):** this endpoint is superseded by **Connect Standard OAuth** —
the merchant authorizes Markii and keeps their own Stripe account, rates, dashboard, and payouts.
Markii stores a revocable token and `stripe_account_id`, **never a merchant secret key**, and
charges are created with `Stripe-Account`.

Markii takes **no `application_fee_amount`, ever**: platform fees are billed on Markii's own
subscription invoice (§17) and never skimmed from the merchant's payment flow. Credentials are
write-only — never echoed by `GET /api/integrations`, never logged, never placed in a prompt.
Status returns `{ mode: "connect_standard", accountId, chargesEnabled, payoutsEnabled, connectedAt }`.

### `DELETE /api/integrations/:provider`
Disconnect. → `{ "status": "not_connected" }`

---

## 9. Readiness & catalog health ✅ LIVE

Powers the Overview score card and `/dashboard/health`.

**Rule-based and deterministic — no model inference, ever.** Every point comes from a named rule in
`lib/readiness/rules.ts` over the merchant's real catalog, so a score can be explained issue by
issue. `docs/PRICING.md` §"Margin check" also makes it a cost constraint: per-product inference on
every plan would exceed every other infrastructure line combined.

**Issues are recomputed on every request, never stored.** A stored issue is a claim that goes stale
the moment someone edits a product — a merchant who has just written a description should see the
issue vanish, not wait for a job. Only what the *merchant decided* persists
(`readiness_issue_states`), keyed by an issue id derived deterministically from the rule and its
subject. That determinism is what makes a dismissal survive tomorrow's recomputation.

**A rule may only check a field this platform actually offers.** The §11 agent-data extension
(`useCases`, `faqs`, `machineSummary`, GTIN, dimensions, compatibility) is Phase E and does not
exist, so nothing scores a merchant on it — marking someone down for a field they have no way to
fill would be a fabricated criticism. Those groups appear in `notMeasured`, with the reason.

**Scoring is per subject, then averaged.** Each product and each store starts at 100 and loses
points for its *own* open issues (critical 20, warning 5, opportunity 1); a component is the mean
across the subjects it covers, and the overall score is the weighted mean of components, rounded
once at the end. The obvious alternative — one running penalty per component — floors at zero and
then stops moving, so a merchant with fifty products missing descriptions would see the same score
after fixing forty-five of them. `checkout`, `policies`, and `protocol_coverage` are scored over
stores, not products, so healthy products cannot drown out a store that cannot take payment.

### Entities

```ts
// AgentReadinessReport
{
  scope: "organization" | "site" | "product",
  scopeId: number | null,          // null for organization
  score: number,                   // 0–100
  grade: "critical" | "needs_work" | "good" | "excellent",
  trend: { delta: number, since: string } | null,
  components: [                    // always these five keys, in this order
    { key: "product_data" | "inventory" | "policies" | "checkout" | "protocol_coverage",
      label: "Product data", score: 72, weight: 0.3,
      issueCounts: { critical: 2, warning: 5, opportunity: 3 } }
  ],
  counts: { critical: 4, warning: 11, opportunity: 6 },
  computedAt: string
}

// ReadinessIssue
{
  id: string,
  severity: "critical" | "warning" | "opportunity",
  component: "product_data" | "inventory" | "policies" | "checkout" | "protocol_coverage",
  code: string,                    // "MISSING_DESCRIPTION", "NO_SHIPPING_POLICY", …
  title: string,
  status: "open" | "resolved" | "dismissed" | "assigned",
  scope: { siteId: number | null, productId: number | null, categoryId: number | null,
           channelId: string | null },
  affectedFields: string[],        // ["description", "gtin"]
  evidence: { field: string, current: string | null, expected: string }[],
  recommendation: string,
  expectedImpact: string,          // plain-language, e.g. "Improves retrieval by ChatGPT/ACP"
  assignedTo: string | null,
  detectedAt: string,
  updatedAt: string
}
```

### `GET /api/readiness/overview`
Query: `siteId`, `productId`, `environment`. → **AgentReadinessReport**.

### `GET /api/readiness/issues`
Query: `severity`, `status`, `siteId`, `productId`, `categoryId`, `channelId`, `component`,
`q`, `page`, `limit`, `sort` (`-severity|detectedAt`).
→ paginated **ReadinessIssue** plus `"counts": { critical, warning, opportunity }`.

### `GET /api/readiness/issues/:id`
→ single **ReadinessIssue** (drawer payload: evidence, affected fields, recommendation, impact).

A 404 here means the issue **is not currently present**, which usually means it was fixed — the
response says so rather than implying a missing row.

### `readiness.updateIssues` — bulk triage (action, §22)
The health table's bulk actions. Invoked as `POST /api/actions/readiness.updateIssues`, not a
route of its own: no route handler mutates state outside the registry (§22 rule 1).

```json
{ "ids": ["iss_1", "iss_2"], "action": "resolve" | "dismiss" | "assign" | "reopen",
  "assignee": "user_1", "note": "why" }
```

→ `{ "updated": 2, "status": "dismissed", "issueIds": [...], "catalogChanged": false }`

`catalogChanged` is always `false` and is stated so no surface can imply a fix happened. **Resolving
is not fixing** — it records "handled outside the rule's view" and stops the issue counting;
`reopen` reverses it and clears the assignee. Fixing the product makes the issue disappear on its
own, with no action needed. `assign` requires a staff member of the *same* org, so an issue cannot
be assigned to a user id from another tenant.

Ids are **not** validated against the current issue set: a merchant may dismiss something about to
reappear, and a row whose issue no longer exists is inert until it comes back.

### `GET /api/readiness/issues/export`
Same filters as the list. → `text/csv`.

### `GET /api/readiness/history`
Query: `scope`, `scopeId`, `from`, `to`.
→ `{ "points": [{ "date": "2026-07-18", "score": 68, "components": { … } }] }`

### `GET /api/readiness/products` — completeness matrix (FR-CM-01)
Query: `siteId`, `categoryId`, `q`, `page`, `limit`, `sort`.

```json
{
  "columns": [
    { "group": "core", "label": "Core", "fields": ["name", "description", "price", "images"] },
    { "group": "shipping", "label": "Shipping", "fields": ["weight", "dimensions", "shipsFrom"] },
    { "group": "policies", "label": "Policies", "fields": ["returns", "warranty"] },
    { "group": "specifications", "label": "Specifications", "fields": ["attributes"] },
    { "group": "compatibility", "label": "Compatibility", "fields": ["compatibleWith"] },
    { "group": "agent_data", "label": "Agent data", "fields": ["useCases", "faqs", "machineSummary"] }
  ],
  "items": [
    { "productId": 9, "name": "Blue Tee", "slug": "blue-tee", "siteId": 1, "score": 64,
      "groups": { "core": { "complete": 4, "total": 4, "state": "complete" },
                  "agent_data": { "complete": 1, "total": 3, "state": "partial" } },
      "issueCount": 3 }
  ],
  "total": 128, "page": 1, "limit": 20
}
```


`state`: `"complete" | "partial" | "empty"`. The contract previously also listed `"conflict"`;
nothing can currently produce it, so it is not emitted rather than declared and never used.

`columns` carries only groups with real fields behind them. Everything else is in `notMeasured`:

```json
{ "notMeasured": [ { "group": "agent_data", "label": "Agent data",
    "fields": ["useCases", "faqs", "machineSummary"],
    "reason": "The product agent-data extension (§11) is not built, so there is nowhere to enter these." } ] }
```

**History is never backfilled.** A score is a function of the catalog as it was, and yesterday's
catalog is gone — so a store scored for three days returns three points, not a flat line invented
back to its creation date. Snapshots are written when the overview is computed, at most once per
scope per day, and an empty series comes back with a `note` saying why rather than zeros a chart
would draw as a crash to nothing.

---

## 10. Channels 🟡 PLANNED

Service: `ChannelService` — `listChannels`, `getChannel`, `validateConfig`, `connectChannel`,
`getSyncHistory`. Powers `/dashboard/channels`.

`kind` is what keeps the UI honest about what a thing *is* (FR-CH-06):

| kind | Members |
|---|---|
| `protocol` | `mcp`, `acp`, `ucp`, `a2a`, `json_ld`, `llms_txt`, `agent_md` |
| `marketplace` | `chatgpt`, `google_ai`, `microsoft` |
| `feed` | `google_merchant` |
| `payment_rail` | `x402`, `stripe`, `paypal` |

### Entities

```ts
// CommerceChannel
{
  id: string,                      // "chatgpt_acp", "google_merchant", "x402"
  name: string,
  kind: "protocol" | "marketplace" | "feed" | "payment_rail",
  status: "connected" | "action_required" | "syncing" | "error" | "test_mode"
        | "ready" | "coming_soon" | "not_connected",
  statusMessage: string | null,
  environment: "test" | "production" | null,
  publishedProductCount: number | null,   // null = not applicable / unknown
  errorCount: number,
  lastSyncAt: string | null,
  docsUrl: string | null,
  capabilities: { discovery: boolean, checkout: boolean, feedSync: boolean },
  configFields: [                  // renders the connect/configure form
    { key: "merchantId", label: "Merchant ID", type: "text" | "password" | "select" | "url",
      required: true, help: string | null, options: string[] | null }
  ],
  siteIds: number[]                // which sites this channel is enabled for
}

// ChannelSyncEvent
{
  id: string,
  channelId: string,
  type: "sync" | "validation" | "connect" | "error",
  status: "success" | "partial" | "failed",
  itemsProcessed: number,
  itemsFailed: number,
  message: string | null,
  startedAt: string,
  finishedAt: string | null
}
```

### `GET /api/channels`
Query: `kind`, `status`, `siteId`, `environment`. → `{ "items": [ CommerceChannel, ... ] }`
(unpaginated — the list is a fixed registry).

### `GET /api/channels/:id`
→ **CommerceChannel** plus `"preview"`:
`{ "format": "json_ld" | "llms_txt" | "agent_md" | "mcp" | "acp" | "ucp", "content": "…" }[]`
— the technical preview pane (FR-CH-04).

### `POST /api/channels/:id/validate`
Body: `{ "config": { … } }` → `200`

```json
{ "valid": false,
  "errors": [ { "field": "merchantId", "message": "Account not found" } ],
  "warnings": [ { "field": "feedUrl", "message": "Feed has 12 products without GTIN" } ] }
```

Validation must not mutate anything.

### `PUT /api/channels/:id/connect`
Body: `{ "config": { … }, "environment": "test" | "production", "siteIds": [1, 2] }`
→ `200` **CommerceChannel**. Secrets are write-only — never echoed back in `GET`.

### `DELETE /api/channels/:id/connect`
Disconnect. → `200` **CommerceChannel** with `status: "not_connected"`.

### `POST /api/channels/:id/sync`
→ `202` `{ "syncId": "sync_1", "status": "syncing" }`

### `GET /api/channels/:id/history`
Query: `from`, `to`, `page`, `limit`. → paginated **ChannelSyncEvent**.

**Today, without these routes:** `json_ld`, `llms_txt`, and `agent_md` statuses are derivable from
real site config (`agentDiscovery`, `indexed`, `status`) via `GET /api/sites`, and `x402` /
`stripe` / `google_merchant` from `GET /api/integrations`. Everything else renders `coming_soon`.
No live protocol connection is in scope.

---

## 11. Product agent-data extension 🟡 PLANNED

Extends the **Product** entity in §4 for the universal product detail tabs (FR-PD-01/02).
All fields optional; `PATCH /api/products/:idOrSlug` accepts them as partials.

```ts
{
  // …existing Product fields…
  attributes: [{ key: "material", label: "Material", value: "Organic cotton",
                 unit: string | null, source: "merchant" | "import" | "inferred" }],
  useCases: string[],              // "Everyday wear", "Gifting"
  compatibility: [{ label: "Fits", value: "US sizes 6–12" }],
  restrictions: [{ type: "age" | "region" | "license" | "shipping", value: "Not shipped to EU" }],
  faqs: [{ question: string, answer: string }],
  machineSummary: string | null,   // one-paragraph agent-facing description
  policies: { returns: string | null, warranty: string | null, shipping: string | null },
  gtin: string | null,
  brand: string | null,
  condition: "new" | "refurbished" | "used" | null,
  availability: "in_stock" | "out_of_stock" | "preorder" | "backorder",
  freshness: { lastVerifiedAt: string | null, staleAfterDays: number | null }
}
```

### `GET /api/products/:idOrSlug/health` (Health tab)

```json
{
  "score": 64,
  "components": [ { "key": "product_data", "score": 70 } ],
  "fields": [
    { "field": "description", "state": "complete" | "partial" | "empty" | "conflict" | "stale",
      "message": null, "severity": null }
  ],
  "issues": [ ReadinessIssue, ... ],
  "conflicts": [ { "field": "price", "sources": ["markii", "shopify"], "values": ["19.99", "24.99"] } ]
}
```

### `GET /api/products/:idOrSlug/preview` (Channel Preview tab)
Query: `format=human|json_ld|llms_txt|agent_md|mcp|acp|ucp` (repeatable).

```json
{ "previews": [ { "format": "json_ld", "contentType": "application/ld+json", "content": "{…}" } ] }
```

Deterministic serialization of the **saved** product — same input, same output.

---

## 12. Agent Test Lab 🟡 PLANNED

Service: `AgentTestService` — `listProfiles`, `runScenario`, `saveScenario`, `getScenario`.

```ts
// AgentTestScenario
{ id: string, name: string, query: string, profileId: string, siteId: number | null,
  createdAt: string }

// AgentTestResult
{
  id: string, scenarioId: string | null, query: string, profileId: string,
  dataSource: "production" | "test" | "demo",
  retrieved: [{ productId: number, name: string, slug: string, score: number }],
  selected: [{ productId: number, name: string, reason: string }],
  rejected: [{ productId: number, name: string, reason: string,
               missingFields: string[] }],
  constraintsUsed: [{ constraint: "budget", value: "< $50", satisfiedBy: [9, 12] }],
  attributesUsed: string[],
  missingInformation: [{ field: string, productIds: number[], impact: string }],
  conflicts: [{ field: string, productIds: number[], detail: string }],
  confidence: number,              // 0–1
  checkoutReadiness: {
    ready: boolean,
    blockers: [{ code: string, message: string }],
    availableRails: ["x402", "stripe", "card"]
  },
  protocolOutput: [{ format: string, content: string }],
  runAt: string
}
```

### `GET /api/test-lab/profiles`
→ `{ "items": [ { "id": "budget_shopper", "name": "Budget shopper",
      "description": "Optimizes for lowest total cost",
      "constraints": [{ "key": "maxPrice", "label": "Max price", "value": "50" }] } ] }`

### `POST /api/test-lab/run`
Body: `{ "query": "waterproof running shoes under $120", "profileId": "budget_shopper",
"siteId": 1, "environment": "test" }` → `200` **AgentTestResult**.

### `GET /api/test-lab/scenarios` · `POST /api/test-lab/scenarios` · `GET /api/test-lab/scenarios/:id`
List / save / load. Save body: `{ "name", "query", "profileId", "siteId" }` → `201`.

**Rules.** `rejected[].reason` and `constraintsUsed` are **structured product reasoning** —
evidence about catalog data, never model chain-of-thought (FR-TL-06 scope note). Runs against a
site with no products return `retrieved: []` with a real empty state, not invented matches. Until
this ships, the Test Lab UI is interface-only and must say so.

---

## 13. Orders (promoted from Finances) — ✅ LIVE

`GET /api/orders`, `GET /api/orders/export`, and `GET /api/orders/:id` are ✅ LIVE; the timeline
ships **inside** the detail response rather than as its own call (§18.7). Client service:
`lib/api/orders.ts` — `listOrders`, `ordersExportUrl`.
Settlement history moves under Orders as a tab (FR-OR-06); §7's finances endpoints stay live and
back it.

### Extended Order entity — 🟡 aspirational

**Nothing below this line is a column yet.** `channelId`, `environment`, `paymentRail`,
`exception`, `payment`, `fulfillment`, and `buyerAuthorization` were sketched against a schema
that was never built. What the live routes return is the v1 **Order** plus §18.7's
`financialStatus`, `fulfillmentStatus`, the money split (`subtotalMinor`, `discountMinor`,
`taxMinor`, `shippingMinor`, `refundedMinor`), `email`, and `cancelledAt` / `cancelReason`. The
rail lives in `provider` (`x402 | stripe`).

```ts
{
  // …existing Order fields from §"Order (transaction)"…
  channelId: string | null,        // "chatgpt_acp" — where the order originated
  environment: "test" | "production",
  paymentRail: "x402" | "card" | "stripe" | "paypal" | "external",
  paymentStatus: "pending" | "authorized" | "captured" | "failed" | "refunded" | "partially_refunded",
  fulfillmentStatus: "unfulfilled" | "processing" | "shipped" | "delivered" | "blocked" | "cancelled",
  exception: {                     // null when healthy (FR-OR-05)
    code: "authorization_failed" | "inventory_changed" | "payment_pending" | "fulfillment_blocked",
    message: string,
    since: string
  } | null,
  items: [{ productId: number, name: string, slug: string, quantity: number,
            unitPriceCents: number, totalCents: number }],
  payment: {                       // PaymentSummary
    rail: string, status: string, amountCents: number, currency: string,
    processorReference: string | null,   // tx hash, Stripe PI id, …
    authorizedAt: string | null, capturedAt: string | null,
    refundedCents: number
  },
  fulfillment: {                   // FulfillmentSummary
    status: string, carrier: string | null, trackingNumber: string | null,
    shippingAddress: { line1, line2, city, region, postalCode, country } | null,
    shippedAt: string | null, deliveredAt: string | null
  },
  buyerAuthorization: {            // what the agent was permitted to do
    agentName: string, principal: string | null,
    method: "x402_signature" | "delegated_token" | "api_key" | "unknown",
    scope: string | null, authorizedAt: string | null, verified: boolean
  }
}
```

### `GET /api/orders` ✅ LIVE

Query: `q`, `siteId`, `customerId`, `productId`, `status`, `financialStatus`,
`fulfillmentStatus`, `provider` (`x402|stripe` — the payment rail), `from`, `to`, `page`, `limit`,
`sort` (`-createdAt|createdAt|amountCents|-amountCents`). `q` matches order id, buyer email,
tx hash, agent name, and product name.

**The filters are the columns that exist.** `channelId`, `environment`, `exception`,
`paymentRail`, and `paymentStatus` were written against the planned schema above and have no
column behind them; the route answers **400 naming the replacement** rather than accepting a
filter it cannot honour — an ignored filter returns the whole list, which reads as a match.

→ paginated **Order**, each row extended with `customerId`, `customer` (`{ id, email, name }` or
`null`), `itemised`, `lineCount`, `unitCount`, and `refundableMinor`, plus:

```json
{ "totals": { "orderCount": 87, "byCurrency": [
  { "currency": "USDC", "orderCount": 61, "paidOrderCount": 58,
    "grossMinor": 152300, "refundedMinor": 4200, "netMinor": 148100 } ] } }
```

**Totals are grouped by currency and never summed across it** — a store selling in USDC and USD
has two totals, and one merged number is not money in either (D31). `grossMinor` counts
`status: "success"` only: pending and failed orders are requests, not receipts. `orderCount`
still covers every matched row, so a status filter never looks like an empty result.

### `GET /api/orders/:id/timeline` — ❌ not built, and not planned

The timeline arrives as `timeline` on `GET /api/orders/:id` (§18.7), typed as `order_events`. A
second call would let a screen show a total and a refund history that disagree, because each half
arrived at a different moment. The shape below is the sketch, not the live one:

```json
{ "events": [
  { "id": "evt_1", "type": "order_created" | "payment_authorized" | "payment_captured"
        | "payment_failed" | "inventory_reserved" | "fulfillment_updated" | "refund_issued"
        | "exception_raised" | "note",
    "status": "success" | "warning" | "error" | "info",
    "message": "Agent authorized 145.00 USDC",
    "actor": { "type": "agent" | "merchant" | "system", "name": "ClaudeBot" },
    "metadata": { }, "occurredAt": "2026-07-26T18:00:00.000Z" } ] }
```

### `GET /api/orders/export` ✅ LIVE

Same filters as the list, **from the same builder** — an export that filtered differently from the
screen it was launched from is the copy that reaches an accountant. → `text/csv`, newest first,
`attachment; filename="markii-orders-YYYY-MM-DD.csv"`, `cache-control: private, no-store`.

Columns: `id, created_at, site, status, financial_status, fulfillment_status, payment_rail,
currency, subtotal, discount, tax, shipping, total, refunded, email, product, quantity, tx_hash,
agent`.

Money is written **per row against its own currency's exponent** (D31, `decimalMinor`), as a plain
decimal with no symbol and no grouping separator — `$1,523.00` is two columns in a
comma-separated file.

**Over 10,000 rows the route answers 400 telling the caller to narrow the range.** A CSV truncated
at row 10,000 is indistinguishable from a complete one, and streaming only moves the problem: a
stream that hits the function timeout also arrives looking finished.

`GET /api/finances/sites/:idOrSlug/export` stays ✅ LIVE and covers a single site's transactions.

Operational mutations are **settled, and they are not routes**: `orders.refund`, `orders.cancel`,
`orders.fulfill`, `orders.addNote`, and `orders.resendConfirmation` are registry actions invoked
via `POST /api/actions/:id` (§18.7, §22 rule 1). The routes in this section stay read-only.

---

## 14. Analytics v2 🟡 PLANNED

Service: `AnalyticsService` — `getOverview`, `getFunnel`, `getChannelPerformance`, `getFailures`.
§6's endpoints stay ✅ LIVE and keep backing crawl-traffic views.

**Honesty constraint:** `agent_traffic` currently records **crawls only**. Impressions,
recommendations, sessions, and checkout attempts have no source events yet. Any metric without a
backing event returns `null` — not `0` — and the UI renders *not yet measured*.

### `GET /api/analytics/metrics`
Query: `siteId`, `channelId`, `agentName`, `productId`, `categoryId`, `environment`, `from`, `to`.

```json
{
  "dataSource": "production",
  "metrics": {
    "impressions": null, "retrievals": 1240, "recommendations": null, "sessions": null,
    "checkoutAttempts": 42, "orders": 31, "revenueCents": 152300,
    "conversionRate": 0.0250, "averageOrderValueCents": 4913
  },
  "comparison": { "from": "2026-06-28", "to": "2026-07-25", "deltas": { "retrievals": 0.18 } },
  "byDay": [{ "date": "2026-07-18", "retrievals": 40, "orders": 2, "revenueCents": 9800 }]
}
```

### `GET /api/analytics/funnel`
Same filters. Stages are fixed and ordered (FR-OV-03).

```json
{ "stages": [
    { "key": "retrieved", "label": "Retrieved", "count": 1240, "conversionFromPrevious": null },
    { "key": "recommended", "label": "Recommended", "count": null, "measured": false },
    { "key": "checkout_started", "label": "Checkout started", "count": 42 },
    { "key": "authorized", "label": "Authorized", "count": 35 },
    { "key": "purchased", "label": "Purchased", "count": 31 } ] }
```

`measured: false` ⇒ render "not yet measured", never zero.

### `GET /api/analytics/channels`
→ `{ "items": [ { "channelId": "chatgpt_acp", "name": "ChatGPT / ACP", "retrievals": 800,
      "orders": 18, "revenueCents": 88000, "conversionRate": 0.0225 } ] }`

### `GET /api/analytics/failures`
```json
{ "reasons": [ { "code": "no_match", "label": "No matching product", "count": 64,
                 "sampleQueries": ["waterproof boots size 15"] },
               { "code": "missing_attribute", "label": "Missing required attribute",
                 "count": 22, "affectedProductIds": [9, 12] } ],
  "noMatchQueries": [ { "query": "vegan hiking boots", "count": 12, "lastSeenAt": "…" } ] }
```

### `GET /api/analytics/export`
Same filters. → `text/csv` (FR-AN-06 — no backend report generation required beyond the rows).

---

## 15. Automations, activity, notifications, team 🟡 PLANNED (P2)

### AutomationService — `listTasks`, `approveTask`, `rejectTask`

```ts
// AutomationTask
{
  id: string,
  type: "missing_attributes" | "stale_inventory" | "bundle_suggestion" | "substitution"
      | "sync_failure" | "failed_checkout_investigation",
  title: string,
  explanation: string,             // why this is suggested
  expectedImpact: string,
  status: "suggested" | "approved" | "rejected" | "applied" | "awaiting_backend",
  affectedProducts: [{ id: number, name: string, slug: string }],
  proposedChanges: [{ field: string, current: string | null, proposed: string }],
  createdAt: string
}
```

- `GET /api/automations/tasks` — query `type`, `status`, `siteId`, `page`, `limit`.
- `POST /api/automations/tasks/:id/approve` → `200` **AutomationTask**. If execution is not wired,
  it must return `status: "awaiting_backend"` — never `"applied"` (FR-AU-04).
- `POST /api/automations/tasks/:id/reject` — body `{ "reason": string | null }`.
- `GET /api/automations/history` — paginated **ApprovalEvent**
  `{ id, taskId, action: "approved"|"rejected"|"applied", actor, note, occurredAt }`.

No autonomous execution is in scope.

### ActivityService — `listEvents`, `listNotifications`, `resolveNotification`

- `GET /api/activity` — query `category` (`catalog|channel|agent|deployment|order|error`),
  `siteId`, `from`, `to`, `page`, `limit`. → paginated **ActivityEvent**
  `{ id, category, type, message, actor: { type, name }, severity, link, occurredAt }`.
- `GET /api/notifications` — query `severity` (`critical|warning|info`), `status`
  (`unread|read|resolved`). → paginated **Notification**
  `{ id, severity, title, message, status, action: { label, href } | null, createdAt }`.
- `POST /api/notifications/:id/resolve` → `200` **Notification**.

### Team & settings

- `GET /api/team` → `{ "items": [ TeamMember ] }` —
  `{ id, name, email, role, status: "active"|"invited"|"disabled", lastActiveAt }`.
- `POST /api/team/invite` — `{ "email", "role" }` → `201` **TeamMember** (`status: "invited"`).
- `PATCH /api/team/:id` — `{ "role" }` · `DELETE /api/team/:id`.
- `GET /api/roles` → `{ "items": [ { "key": "catalog_manager", "label": "Catalog Manager",
  "permissions": ["catalog.read", "catalog.write"] } ] }`

Roles: `owner`, `administrator`, `catalog_manager`, `commerce_manager`, `analyst`, `developer`,
`viewer`. **UI model only** — no enforcement until auth exists. Never imply an invitation was
delivered when no mail service is wired.

---

## 16. Accounts, organizations, staff — partial (Phase A in progress)

> **Status (2026-07-31).** ✅ **LIVE:** `POST /api/auth/sign-up · sign-in · sign-out ·
> reset-password · update-password`, `GET /api/auth/callback`, and `GET /api/me`. Sessions are
> httpOnly/`sameSite=lax` cookies written server-side (D30, verified end to end); `proxy.ts`
> refreshes them and redirects signed-out `/dashboard` traffic to `/sign-in`. Sign-up provisions the
> user's first org and an `owner` staff row in one transaction, idempotently. Roles resolve to
> permissions in `lib/auth/permissions.ts`, and the action registry's authorization resolver
> (§22) now reads the staff record instead of denying everything.
>
> ✅ **§1–8 are now org-scoped.** Every data route requires a session and derives scope from it —
> `orgId` is never accepted from the client. `sites.orgId` is the single root; categories, products,
> orders, and traffic reach their org through `siteId`, so there is one choke point rather than five
> denormalized copies that can disagree. `integrations` moved from a `provider` primary key (which
> made it silently single-tenant) to `(orgId, provider)`.
>
> Verified with two live tenants: every list returns `n=0` for the non-owner, every by-id read
> returns **404** (never 403 — that would confirm the id exists), and cross-tenant `PATCH`/`DELETE`/
> `deploy` all fail with the target row unchanged.
>
> ✅ **`GET`/`PATCH /api/org`, `GET /api/org/staff`, `POST /api/org/staff/invite`, and
> `PATCH`/`DELETE /api/org/staff/:id` are live.** `planId` is not settable through `PATCH /api/org` —
> plans change through billing (§17), not by editing the profile. `owner` is not an assignable role:
> there is one owner, recorded on `organizations.ownerId`, changed only by explicit transfer, and
> neither the owner's staff row nor your own may be edited through the staff routes.
>
> **Invitations do not send email yet.** `POST /api/org/staff/invite` creates a real `invited`
> record and returns `invitationEmail: { sent: false, reason }` — §16 requires that an invitation is
> never reported as delivered unless a provider accepted it, and `lib/email/` is `docs/BACKEND.md` §6.
>
> ✅ `sites.orgId` and `integrations.orgId` are now **`NOT NULL`** (migration `0005`, with a guard
> that names any orphans rather than failing on a bare constraint violation).
>
> ✅ **Scoped API/MCP tokens are live** — `GET`/`POST /api/org/tokens`,
> `DELETE /api/org/tokens/:id`. `Authorization: Bearer mk_live_…` authenticates any `/api/*` route,
> with the **same permission checks as a human** (§22 rule 4) and the token's own role, never a
> user's session. Only a SHA-256 is stored: the plaintext is returned once at creation and is
> unrecoverable, `owner` is not a mintable role, and revocation is a soft delete so past audit
> entries stay attributable.
>
> ✅ **Org switching** — `POST /api/org/switch { orgId }`. `GET /api/me` now also returns
> `organizations: [{ id, name, slug, role, active }]` so the dashboard can render a switcher from
> one call. Membership is re-checked server-side on every switch and every request, which is why the
> active-org cookie is a preference rather than a credential.
>
> 🟡 **Still PLANNED:** `/api/org/audit`, `/api/org/sessions*`, and MFA.
>
> ⚠️ **`/api/org/audit` is blocked on there being anything to audit.** The `action_invocations`
> table exists (§22), but no route mutation is defined as an action yet, so the log would be
> permanently empty. It lands with the first Phase C actions rather than as an empty endpoint.

**Blocking dependency for §17–21.** Tenancy model: `Organization → Stores → Staff`. An org owns
billing; stores are the existing `sites`. Recommend a managed auth provider (see `docs/PLAN.md` §4).

```ts
interface Organization {
  id: string; name: string; slug: string;
  ownerId: string;
  billingEmail: string;
  currency: string;                // billing currency, ISO 4217
  country: string;
  planId: string;
  entitlements: Entitlements;      // §17
  createdAt: string;
}

interface StaffMember {
  id: string; orgId: string; userId: string;
  name: string; email: string;
  role: "owner" | "administrator" | "catalog_manager" | "commerce_manager"
      | "analyst" | "developer" | "viewer";
  storeIds: number[] | "all";      // per-store scoping
  status: "active" | "invited" | "disabled";
  lastActiveAt: string | null;
}
```

| Method | Route | Notes |
|---|---|---|
| `POST` | `/api/auth/sign-up` | `{ email, password }` → creates the user *and* their first org. Server-side (D30) |
| `POST` | `/api/auth/sign-in` | `{ email, password }` → sets the session cookie. Server-side (D30) |
| `POST` | `/api/auth/sign-out` | Clears the session cookie |
| `POST` | `/api/auth/reset-password` | `{ email }` → sends the reset mail. Always `200`, even for an unknown address — never confirm whether an account exists |
| `POST` | `/api/auth/update-password` | `{ password }`, authorized by the recovery session |
| `GET` | `/api/auth/callback` | Exchanges the emailed code for a session, then redirects. Confirmation, recovery, and any future OAuth land here |
| `GET` | `/api/me` | Current user, org, role, entitlements — one call to boot the dashboard |
| `GET`/`PATCH` | `/api/org` | Org profile, billing email, currency |
| `GET` | `/api/org/staff` | List staff |
| `POST` | `/api/org/staff/invite` | `{ email, role, storeIds }` → `201`, `status: "invited"` |
| `PATCH`/`DELETE` | `/api/org/staff/:id` | Change role/scope, remove |
| `GET` | `/api/org/audit` | Audit log: actor, action, entity, before/after, IP, `occurredAt` |
| `GET` | `/api/org/sessions` · `DELETE /api/org/sessions/:id` | Active sessions, revoke |
| `GET`/`POST` | `/api/org/tokens` · `DELETE /api/org/tokens/:id` | Scoped API/MCP tokens (§22) |

`GET /api/me` — the shape the dashboard boots from, and the **only** way a screen learns who the
user is. Never read identity from a client-side session:

```json
{
  "user": { "id": "...", "name": null, "email": "merchant@example.com" },
  "org": { "...": "Organization, above" },
  "role": "owner",
  "entitlements": { "...": "§17 Entitlements — mirrors org.entitlements" }
}
```

`401` when unauthenticated: `{ "error": { "code": "UNAUTHENTICATED", "message": "..." } }`. The
dashboard treats that as "redirect to sign-in", not as an error state.

### Auth requirements

Merchant accounts are now a confirmed requirement, so this is a real auth surface, not a shim:

- **Sign-up, sign-in, sign-out, password reset, email verification**, and session refresh come from
  **Supabase Auth** (D3), never hand-rolled credential storage.
- **Auth mutations run server-side only** (D30). The routes above are Markii's own origin, using
  Supabase's `createServerClient`; the browser never calls Supabase Auth and no
  `createBrowserClient` exists in the dashboard. This is not a style preference: a cookie set from
  `document.cookie` **cannot be `HttpOnly`**, so a browser-side sign-in silently fails the rule
  below while appearing to satisfy it.
- **Sessions** are httpOnly, secure, SameSite cookies, written by the server. Never store tokens in
  `localStorage` — the storefronts run custom merchant code, and any XSS there must not reach an
  admin session. Refresh happens in `proxy.ts`, not in the client.
- **MFA** available on all plans; enforceable org-wide by an Owner. SSO/SAML is a later
  enterprise-tier concern, but the role model should not foreclose it.
- **A user may belong to multiple orgs** (agencies build stores for clients) — the session carries
  an active org, switchable, and every request derives scope from it.
- **Programmatic access** uses scoped tokens with an explicit role, never a user's session cookie.
  Same permission checks, same audit log; this is what MCP clients and CI use (§22).

Storefront **customer** accounts (§18.3) are a separate identity domain — different users,
different sessions, different store scope — but **share one Supabase project with staff** (D32), so
`auth.users` stays joinable. Because they no longer get separate token audiences for free, three
things are binding: authorization always resolves through a membership/`customers` lookup and never
`auth.getUser()` alone; session cookies are host-only, never scoped to the parent domain; and
`user_kind` is explicit on the user record rather than inferred.

**Rules.** Every §1–15 route gains implicit org scoping from the session — never accept `orgId`
from the client. Role checks are enforced **server-side**; the UI role model mirrors but never
substitutes for it. Audit every mutation with actor identity, including agent and token callers.
Never return an invitation as "delivered" unless a mail provider actually accepted it.

---

## 17. Billing, plans, metering, threshold fees — partial ✅/🟡 Phase B

Full model in **`docs/PRICING.md`**. Processor: Stripe Billing (subscriptions) + Stripe Connect
(merchant payouts). Markii never holds merchant funds.

**✅ LIVE — everything that does not need Stripe.** The `UsageRecord` ledger (shipped with checkout,
because it cannot be derived later), the **threshold fee engine** (`lib/billing/fees.ts`), the
**meter** (`GET /api/billing/usage`), the plan catalog, entitlements, and **period close** into an
immutable `fee_assessments` ledger with a reconciliation check.

**🟡 Blocked on `STRIPE_SECRET_KEY`.** Subscriptions, plan changes, proration, payment methods,
invoices, and dunning. These **refuse with `503 CONFIGURATION_REQUIRED`** rather than
returning stubs: a plan change that moved `organizations.planId` without a subscription behind it
would grant a higher threshold and more storefronts for free with nothing sold, and a fake
SetupIntent secret fails inside Stripe's own card element *after* the merchant types their card
number.

**Nothing is being charged, and every billing response says so.** `billingStatus.charging` is
`false` and carries the reason; `fee_assessments.invoiced` is `false`. The figures are a
measurement, not an invoice — the same framing §4.4 requires for trial orgs, for the same reason.

```ts
interface Entitlements {           // gate features on THIS, never on plan name
  storeLimit: number; staffSeatLimit: number | null;
  gmvThresholdMinor: number;       // annual threshold in billing currency minor units
  overageRateBps: number;          // e.g. 50 = 0.50%
  addOns: { agentOps: boolean; chargebackAssist: boolean };
}

interface Subscription {
  planId: "starter" | "growth" | "scale";
  interval: "month" | "year";
  status: "trialing" | "active" | "past_due" | "canceled" | "unpaid";
  currentPeriodStart: string; currentPeriodEnd: string;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
}

interface UsageRecord {            // immutable; written at event time, never derived later
  id: string; orgId: string; storeId: number; orderId: number;
  type: "sale" | "refund" | "chargeback_lost";
  amountMinor: number; currency: string;          // original
  convertedMinor: number; fxRate: number;         // billing currency
  environment: "test" | "production";             // test NEVER counts
  occurredAt: string;
}
```

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/billing/plans` | Public plan catalog + prices. Competitor comparisons are **data with a `verifiedAt`**, never hardcoded copy |
| `GET` | `/api/billing/subscription` | Current subscription + entitlements |
| `POST` | `/api/billing/subscription` | Create/change plan. Returns proration preview before commit |
| `DELETE` | `/api/billing/subscription` | Cancel at period end |
| `GET` | `/api/billing/usage` | **The threshold meter** — see below |
| `GET` | `/api/billing/invoices` · `/:id` | History + line-itemized detail |
| `POST` | `/api/billing/payment-method` | Stripe SetupIntent client secret; card data never touches Markii |
| `POST` | `/api/billing/addons/:addon` · `DELETE` | Toggle add-on entitlement |
| `POST` | `/api/webhooks/stripe` | ✅ LIVE — signature-verified, idempotent, retry-safe. **No handlers yet** (see below) |

### `POST /api/webhooks/stripe` — ✅ LIVE (unauthenticated, signature-verified)

Built **ahead of** the routes it will feed, because an event dropped while a handler was missing is
never redelivered. It verifies, records, and acknowledges; it does not yet change billing state,
because nothing downstream of it is built.

- **Two endpoints point here.** Connect delivers events for *merchants'* accounts as well as
  Markii's own. An event carrying `account` is a connected merchant's; one without it is the
  platform's. They are configured separately in Stripe with **separate signing secrets**, and the
  route **never falls back** from one secret to the other — sharing them would make an unverifiable
  event look verified.
- **The signature is the only authentication.** HMAC-SHA256 over `${timestamp}.${rawBody}`,
  compared in constant time, with a 5-minute tolerance so a captured event cannot be replayed
  forever. Hand-rolled over `node:crypto` (`lib/payments/stripe-webhook.ts`), matching the SigV4
  and SNS precedents. Multiple `v1` signatures are accepted, so a secret roll does not drop events.
- **Idempotent on Stripe's event id**, which is the primary key of `stripe_webhook_events`. A
  redelivery collides instead of running a handler twice — `invoice.paid` processed twice is a
  merchant charged twice.
- **Status codes are chosen for Stripe's retry behaviour**, which is the opposite of the SES
  webhook's: missing secret → `503`, bad signature → `400`, duplicate → `200`, recognised but
  unhandled → `200` with the reason recorded, handler threw → **`500` so Stripe retries** over its
  three-day window.
- Every event is recorded with a status of `received` / `processed` / `ignored` / `failed`, and
  `ignored` and `failed` **must** carry a reason — enforced by a database check, because a decision
  with no reason recorded is indistinguishable from a handler that silently did nothing.

### `GET /api/billing/usage` — threshold meter

```json
{
  "currency": "USD",
  "trailing12NetSalesMinor": 48200000,
  "thresholdMinor": 50000000,
  "overageRateBps": 40,
  "state": "below" | "approaching" | "above",
  "period": { "start": "2026-07-01", "end": "2026-07-31" },
  "periodNetSalesMinor": 6000000,
  "billableThisPeriodMinor": 0,
  "feeAccruedMinor": 0,
  "projectedPeriodFeeMinor": 64000,
  "projectionBasis": "run_rate_to_period_end",
  "upgradeSuggestion": { "planId": "scale", "monthlyDeltaMinor": 10000,
                         "projectedAnnualSavingMinor": 42000 } | null,
  "processorFeesNote": "Charged by your payment provider, not part of your Markii bill.",
  "dataSource": "production"
}
```

**Contract rules.** `billableThisPeriodMinor` uses the marginal formula in `docs/PRICING.md` §4.3 —
only the slice above the threshold, never the whole period. Projections are always labeled as
projections and never presented as owed. Before a first sale exists, values are `null` and the UI
shows *not yet measured*, never `0`. Trial orgs see accrual with "would have been charged" framing.
`upgradeSuggestion` is surfaced even when it lowers Markii's revenue.

**Two fields beyond the shape above**, both about being honest when the number is incomplete:

- `billingStatus: { charging, reason }` — false while Stripe is unwired, with the reason. The meter
  shows figures that look like a bill; it has to say they are not one.
- `unconvertedRecordCount` — usage records whose currency could not be converted to the org's
  billing currency. No FX provider is wired, so those store `convertedMinor: null` rather than an
  invented rate (§4.1: "never retro-recompute"). Summing them as zero would understate a merchant's
  threshold, so they are excluded **and counted**, making the gap visible rather than silent.

**The engine is exact and tested against the published example.** `lib/billing/fees.test.ts`
reproduces §4.3's worked case verbatim — Growth, $750k threshold, enters at $730k T12, sells $60k →
$40k billable, **$160**. If that test ever fails, either the code or the published pricing is wrong.
Rounding is **half-even**: half-up would bias every fee upward by half a minor unit on average,
systematically in Markii's favour across every merchant and month.

`billable` is capped at the period's own sales and floored at zero. A refund-heavy period does not
produce a negative fee silently netted off — §4.4 makes that a credit on the *next* invoice at the
rate originally charged.

### Period close — `fee_assessments`

The meter recomputes from the ledger on every request, which is right for a live number. **What a
merchant was assessed must stop moving**, so closing a period freezes it with the inputs that
produced it (`workings`), the plan terms in force at close, and the record count. Closing is
idempotent on `(orgId, periodStart)` — a retried scheduler must not double-bill.

`reconcileAssessment()` recomputes a closed period and **reports drift without correcting it**. A
settled number that silently changes is worse than a wrong one somebody can see; drift means either
a late record (a §4.4 credit) or a bug, and both need a human.

**The nightly `t12_net_sales` rollup in §4.5 is deliberately not built.** Nothing schedules jobs in
this deployment yet, and a cache nobody refreshes is worse than the query it replaces. The direct
sum is exact and uses `usage_records_org_occurred_idx` — the index a rollup would have been built
on anyway. Add the rollup when volume demands it, not before there is a scheduler to keep it fresh.

---

## 18. Commerce core — partial ✅/🟡 Phase C

The gap between "catalog" and "store". Everything here is prerequisite to a real shopper checking
out. Extends §4's Product.

### 18.1 Variants & inventory — ✅ partially LIVE

> **Live (2026-07-31).** Reads: `GET /api/products/:idOrSlug/variants` (matrix + option axes +
> ledger-derived levels), `GET /api/inventory/levels` (filters: `siteId`, `productId`, `locationId`,
> `lowStock`), `GET /api/locations`.
>
> **Writes go through the action registry (§22), not REST verbs** — `catalog.setProductOptions`,
> `catalog.updateVariant`, `inventory.adjust`, `inventory.createLocation`. There is deliberately no
> `POST /api/products/:id/variants`: a variant that does not correspond to an option combination has
> no coherent identity, so variants are created by regenerating the matrix.
>
> **Regeneration preserves.** Adding a value creates only the new combinations and keeps existing
> variants' price, SKU, and stock. Removing a value **reports orphans rather than deleting them** —
> deleting a variant cascades away its inventory ledger, which is not a side effect an option edit
> should have.
>
> Levels are always summed from the ledger, never stored. Still planned: `PATCH`/`DELETE
> /api/variants/:id` as REST aliases, and multi-location committed-stock flows (which arrive with
> checkout, §18.4).

### 18.1 Variants & inventory

```ts
interface ProductOption { name: string; position: number; values: string[] }   // Size, Color

interface Variant {
  id: number; productId: number;
  title: string;                   // "Navy / L"
  optionValues: Record<string, string>;
  sku: string | null; barcode: string | null;
  priceMinor: number; compareAtMinor: number | null; costMinor: number | null;
  weightGrams: number | null;
  requiresShipping: boolean; taxable: boolean; taxCode: string | null;
  imageId: string | null;
  inventoryPolicy: "deny" | "continue";   // sell past zero?
  inventoryLevels: { locationId: string; available: number; committed: number }[];
  position: number;
}
```

| Method | Route |
|---|---|
| `GET`/`POST` | `/api/products/:id/variants` |
| `PATCH`/`DELETE` | `/api/variants/:id` |
| `POST` | `/api/products/:id/options` — regenerates the variant matrix |
| `GET`/`POST` | `/api/locations` — inventory locations |
| `POST` | `/api/inventory/adjust` — `{ variantId, locationId, delta, reason }`, appends a ledger entry |
| `GET` | `/api/inventory/levels` — filter by location/variant/low-stock |

Inventory is an **append-only ledger**, not a mutable integer — reconciliation and audit depend on
it, and so does the Agent Ops undo path.

### 18.2 Collections — ✅ LIVE

> **Live (2026-07-31).** Reads: `GET /api/collections`, `GET /api/collections/:idOrHandle`.
> Writes via §22 actions: `catalog.createCollection`, `catalog.updateCollection`,
> `catalog.setCollectionProducts`, `catalog.deleteCollection`.
>
> **Rule fields are narrower than the type below.** Products carry no `tag`, `vendor`, or `type`
> column, so rules on those fields are **rejected with an explanatory error** rather than accepted
> and silently matching nothing. Supported today: `title`, `price`, `stock`, `sku`. Numeric fields
> take `eq`/`gt`/`lt`; text fields take `eq`/`contains`/`starts_with` — a mismatched pair is also
> refused. The other three become available when the product model grows those fields.
>
> **Automated membership resolves at read time, never materialised.** A cached membership goes stale
> the moment a price or stock level changes, and an "Under £20" collection listing a £30 product is
> a worse failure than a slower query. Verified: repricing a product removes it from the collection
> on the next read.
>
> A rule set with no usable rules yields an **empty** collection, never the whole catalog — widening
> is the dangerous direction to fail in. `setCollectionProducts` is refused on automated collections,
> and deleting a collection leaves its products untouched.
>
> `best_selling` sort currently falls back to newest-first: there is no order-line data to rank by
> until checkout ships (§18.4). It does not invent a ranking.

### 18.2 Collections

```ts
interface Collection {
  id: number; storeId: number; title: string; handle: string;
  description: string | null; imageUrl: string | null;
  type: "manual" | "automated";
  rules?: { field: "title"|"tag"|"price"|"stock"|"vendor"|"type";
            op: "eq"|"contains"|"gt"|"lt"|"starts_with"; value: string }[];
  rulesMatch?: "all" | "any";
  sortOrder: "manual" | "best_selling" | "price_asc" | "price_desc" | "created_desc";
  productCount: number; publishedAt: string | null;
}
```

`GET`/`POST` `/api/collections`, `GET`/`PATCH`/`DELETE` `/api/collections/:idOrHandle`,
`POST /api/collections/:id/products` (manual membership + reorder).
Collections coexist with the existing §3 categories: **categories are catalog taxonomy, collections
are merchandising.** Do not merge them; do document the distinction in the UI.

### 18.3 Customers — ✅ LIVE (records; shopper *login* is separate)

> **Live (2026-07-31).** Reads: `GET /api/customers`, `GET /api/customers/:id`,
> `GET /api/customers/:id/orders`, `GET /api/customers/:id/memberships` (§18.9). Writes via §22
> actions: `customers.create`, `customers.update`, `customers.addAddress`, `customers.delete`.
>
> **Frontend:** `/dashboard/customers` and `/dashboard/customers/:id` (2026-08-03) — list with
> search and store filter, detail with memberships, orders, and addresses.
>
> **A customer record is not a login.** Guest checkout creates a customer with no `authUserId`; an
> account links one later. `customers.authUserId` points at `auth.users` (D32 — one project) with no
> foreign key, since that schema belongs to `supabase_auth_admin`.
>
> **Shopper login is ✅ LIVE as of 2026-08-03** (D34) — it landed with membership gating, which
> could not be enforced without it. Routes and the identity rules are in **§18.9**.
>
> **Linking a guest record requires a confirmed address.** Guest rows carry order history, so
> attaching one to whoever signs up with that email would let anybody claim a stranger's orders. An
> unconfirmed shopper gets a session but no linkage, and `accountLinked: false` says so.
>
> **D32's `user_kind` is enforced from here on.** It lives in **`app_metadata`**, not
> `user_metadata` — the latter is user-writable, so a shopper could otherwise promote themselves by
> calling `updateUser`. Verified: a `customer`-kind user **with a valid owner staff row** still gets
> `401` from `/api/me` and every data route.
>
> **PII (§18.3).** Marketing consent defaults off, is timestamped on grant, and its timestamp is
> **cleared on withdrawal** — a stale one would misrepresent the record if produced as evidence.
> Customer actions carry `redactInput`, so emails, names, and phone numbers never reach the
> long-lived audit table; diffs record which field changed, not to what.
>
> **Erasure keeps the financial record.** `customers.delete` is `high` risk (irreversible,
> privacy-affecting). It removes the customer and their addresses; orders survive with
> `customerId` nulled, because erasing a person must not destroy the merchant's tax records.
>
> `ordersCount` / `totalSpentMinor` are derived from **successful** orders only, never stored — a
> denormalised total drifts after the first refund.

### 18.3 Customers

`Customer { id, storeId, email, firstName, lastName, phone, addresses[], defaultAddressId,
acceptsMarketing, marketingConsentAt, tags[], note, ordersCount, totalSpentMinor, createdAt }`

`GET`/`POST` `/api/customers`, `GET`/`PATCH`/`DELETE` `/api/customers/:id`,
`GET /api/customers/:id/orders`, `POST /api/customers/:id/addresses`.

PII rules: never log or prompt-inject customer records; support export and deletion requests;
marketing consent is explicit, timestamped, and never defaulted on.

### 18.4 Cart & checkout ✅ LIVE (x402 rail) · 🟡 card rail PLANNED

```ts
interface Cart {
  token: string; storeId: number;
  lines: { id: number; productId: number; variantId: number | null; title: string;
           quantity: number; unitPriceMinor: number; lineTotalMinor: number;
           addOns: { productId: number; name: string; unitPriceMinor: number;
                     mandatory: boolean }[];
           issues: LineIssue[] }[];
  customerId: number | null; email: string | null;
  discountCodes: string[];
  subtotalMinor: number;
  // Each component carries WHY it is what it is — see "Money components" below.
  discount: MoneyComponent; tax: MoneyComponent; shipping: MoneyComponent;
  totalMinor: number;
  totalState: "final" | "provisional";
  currency: string;
  shippingAddress: Address | null; shippingRateId: string | null;
  status: "open" | "abandoned" | "converted";
  issues: LineIssue[];          // blocking; a cart with any of these cannot check out
  expiresAt: string;
}

type MoneyComponent = {
  amountMinor: number;
  state: "calculated" | "none" | "not_configured";
  note?: string;
};

type LineIssue =
  | { code: "price_changed"; wasMinor: number; nowMinor: number }
  | { code: "unavailable"; reason: string }
  | { code: "insufficient_stock"; available: number; requested: number };
```

**Routes are under the site tree, not `/api/storefront/*`.** On a storefront host `proxy.ts`
rewrites every path to `/_sites/{slug}/…`, so a platform-shaped path is unreachable from the store
the shopper is actually standing in. The slug therefore comes from the Host header, which also means
a cart can never be created against a different store than the one being browsed.

| Method | Route (storefront host) | Notes |
|---|---|---|
| `POST` | `/api/cart` | Create cart; optional first line |
| `GET`/`PATCH` | `/api/cart/:token` | Read; add / set-quantity (0 removes) / set email + address |
| `POST` | `/api/cart/:token/discount` | Apply or remove a code (§18.5). A rejection says **why** |
| `POST` | `/api/cart/:token/shipping-rates` | Quote the merchant's rates for an address (§18.6) |
| `POST` | `/api/checkout/session` | Freeze the quote → reserve inventory → start payment on a rail |
| `POST` | `/api/checkout/session/:id/complete` | Verify payment → Order → redemptions → **UsageRecord (§17)** |
| `GET`/`POST` | `/api/checkout` | The x402 one-shot (402 challenge → pay → present hash) |

Money is **always recomputed server-side**; no request body has a price, total, or discount field to
supply one in. Cart tokens are 256-bit CSPRNG values — the token is the shopper's only credential,
so it protects an email and a shipping address and is never derived from the row id.

**Money components.** `discount`, `tax`, and `shipping` each carry a `state`, because a bare `0`
cannot distinguish "nothing is owed" from "we cannot calculate this" — and rendering the second as
the first is the fabrication `CLAUDE.md` forbids, at the exact moment a shopper decides to pay.
All three come from real configuration: discounts from §18.5, tax and shipping from §18.6.

**`totalState` is the field a checkout button must read.** It answers only "is this safe to charge?"
An unapplied discount code leaves it `final` — the shopper pays list price and has been told the
code did nothing; refusing there would lock a shopper out of a valid sale over a code the store
never offered. An uncalculated **shipping** or **tax** cost makes it `provisional` and checkout
returns 409, because that cost is real and charging zero means the merchant absorbs it or owes it.

**Inventory is reserved at payment authorization** into `inventory_reservations`, with the movement
appended to `inventory_ledger` as `committedDelta`. The last-unit race is solved with `SELECT … FOR
UPDATE` on the variant row *inside* the transaction, never an application-level read-then-write;
reservations are taken in ascending variant id so two carts cannot deadlock. Holds expire after 15
minutes and are swept before each new reservation. `products.stock` remains the source for products
that predate §18.1 variants — reading the wrong one of the two oversells.

Card data will go to Stripe-hosted elements only (PCI SAQ-A). **The card rail is not implemented**:
`lib/payments/` returns an explicit `configuration_required`, and `/complete` refuses a `stripe`
session rather than accepting the caller's word that payment succeeded.

The x402 agent checkout in `app/%5Fsites/[site]/api/checkout/` is a peer path into **the same order
pipeline** (`lib/commerce/orders.ts`) and writes the same usage records. It still quotes
`price × quantity` with no tax or shipping, because that is what its 402 challenge advertised and the
agent has already settled on-chain by the time the second request arrives — refusing after
settlement would strand their money. When §18.6 lands, the fix belongs in the challenge.

### 18.5 Discounts ✅ LIVE · gift cards ⛔ DEFERRED (D33)

```ts
interface Discount {
  id: number; siteId: number;
  code: string | null;              // null = automatic, applied with nothing typed
  title: string;
  type: "percentage" | "fixed" | "free_shipping";
  percentageBps: number | null;     // 1500 = 15%. Integer, never a float (D31)
  valueMinor: number | null;
  appliesToScope: "order" | "products" | "collections"; appliesToIds: number[];
  minimumSubtotalMinor: number | null;
  customerEligibility: "all" | "specific"; eligibleCustomerIds: number[];
  usageLimit: number | null; usageLimitPerCustomer: number | null;
  combinesWithProduct: boolean; combinesWithOrder: boolean; combinesWithShipping: boolean;
  startsAt: string | null; endsAt: string | null;
  enabled: boolean;
  status: "active" | "scheduled" | "expired" | "disabled";  // derived
  usedCount: number;                                        // derived
  exhausted: boolean;
}
```

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/discounts` | Filter by `siteId`, `q`, `automatic`, `status` |
| `GET` | `/api/discounts/:id` | Plus redemption history and `totalDiscountedMinor` |
| `POST` | `/api/discounts/validate` | **Preview** — writes nothing, consumes no usage allowance |
| `POST` | `/api/cart/:token/discount` | Storefront: apply or remove a code |

Mutations are actions (§22): `discounts.create` · `update` · `delete`.

**`status` and `usedCount` are derived, never stored** — status from `enabled` plus the date window,
usage from `discount_redemptions`. A stored counter drifts the first time a redemption is reversed,
and a usage limit enforced against a drifted counter either blocks valid customers or lets a
single-use code run forever. Same reasoning as inventory levels and customer totals.

**A rejected code says why.** `not_found`, `disabled`, `not_started`, `expired`, `below_minimum`
(with the minimum *and* the current subtotal), `usage_limit_reached`, `customer_limit_reached`,
`not_eligible`, `no_matching_items`, `does_not_combine`. "Invalid code" for all ten would leave a
shopper who is £2 short of a threshold with no idea they are £2 short.

**Rejected codes are not stored on the cart** — except `below_minimum`, which is the one rejection
the shopper can fix by adding to their cart, so that code stays and starts working when they do.

**Stacking is opt-in on both sides.** A second discount joins the first only if *each* one's
`combinesWith*` flag permits the other's kind. All three flags default to `false`: defaulting to
combinable is how a store wakes up having sold everything at 70% off.

A `fixed` discount never exceeds what it applies to, and the total discount never exceeds the
subtotal — an order can reach zero but never goes negative. `free_shipping` zeroes the chosen
shipping rate rather than removing it, so the merchant's record still shows which service was used.

**Redemptions are recorded at order completion**, from the discounts frozen on the checkout session
— not re-evaluated, since a code that hit its limit in between would silently raise a price the
shopper already agreed to. The unique key on `(discountId, orderId)` makes a retried completion
unable to burn a code twice. **Known limit:** two *different* checkouts racing for a
last-remaining use can both complete, exceeding `usageLimit` by one; refusing after payment is worse
on the x402 rail, where the shopper has already settled on-chain.

**Frontend:** `/dashboard/discounts` (2026-08-03) — list with status and store filters, derived
redemption counts, and a **Fully redeemed** badge, since an exhausted code still reads as active by
its dates and only fails when a shopper tries it. Creation still goes through §22 actions; there is
no builder screen yet.

**Gift cards are deferred until further notice (D33, 2026-08-03)** — not "planned next". Nothing in
`/api/gift-cards` is to be built, and **no schema should anticipate them**. They count toward net
sales at **redemption**, not purchase (`docs/PRICING.md` §4.1) — but note that exclusion is
currently *asserted and unimplemented*: `lib/commerce/orders.ts` computes
`subtotalMinor − discountMinor` with no gift-card term, so adding them as a product line would
double-bill merchants and adding them as a discount would under-bill. See D33 for the three
prerequisites (split tender, stored-value ledger, metering term).

### 18.6 Tax & shipping rates ✅ LIVE (shipping + manual tax) · 🟡 Stripe Tax PLANNED

Rate *configuration*, not logistics. **Out of scope permanently:** carrier rate shopping, label
purchase, tracking sync (`docs/PLAN.md` §3).

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/shipping/zones` | Zones with their rates. A zone with **no** rates is returned with a `warning` — it silently refuses every checkout to that destination |
| `GET` | `/api/shipping/rates` | All rates across the org, each with its zone |
| `GET` | `/api/settings/tax` | Settings + an `operational` field saying whether the chosen provider can actually calculate |
| `POST` | `/api/tax/calculate` | **Preview only** — writes nothing, never the source of a charged amount |

Mutations are actions (§22): `shipping.createZone` · `updateZone` · `deleteZone` ·
`createRate` · `updateRate` · `deleteRate` · `tax.updateSettings`.

**Zones resolve most-specific-first** — a zone naming provinces beats one naming only the country,
which beats a zone with no countries at all (the merchant's catch-all). Two matching rules whose
winner depends on row order is regional pricing that silently stops applying.

**Rate types:** `flat`, `weight_based` (grams, from variant weights), `price_based` (subtotal
bounds), and `free_over_threshold`. Bounds are **inclusive at both ends** — a merchant writing
"0–1000g £3, 1000–5000g £6" means a 1000g parcel costs £3. `free_over_threshold` treats
`minSubtotalMinor` as an ordinary eligibility bound: it is **not offered at all** below the
threshold and is always free above it, and the action layer forces `priceMinor` to 0 so no merchant
sets a number that does nothing.

**A selected rate is always re-quoted, never trusted from the cart.** If the cart shrinks below a
free-shipping threshold, the selection stops applying and the total goes back to `provisional`
rather than quietly staying free.

**Tax providers:** `none` (no tax line; prices stand as listed), `manual` (the merchant's own rates
by country/province, in **basis points** so a rate is an integer), and `stripe` (Stripe Tax — the
decided provider, `docs/DECISIONS.md` G3, not yet implemented). Rates resolve most-specific-first
like zones. With `pricesIncludeTax` the tax is **extracted** from the price (`p × r / (1 + r)`),
never added — adding it would charge the shopper twice. All arithmetic is integer, half-up (D31).

**A provider that cannot calculate blocks checkout.** `manual` with no rate for the destination, or
`stripe` with no credentials, returns `not_configured` and the sale is refused — a merchant who
selected a tax provider is telling us they collect tax, and completing without it leaves them owing
money they never charged. A store on `provider: "none"` is unaffected.

**Markii never gives tax advice** (`docs/DECISIONS.md` G2). Under Connect Standard the merchant is
the seller of record and the taxpayer; `GET /api/settings/tax` returns that disclaimer as data.

### 18.7 Order operations ✅ LIVE · 🟡 processor-executed refunds PLANNED

Extends §13. Reads are REST; **every mutation is an action** (§22 rule 1), so the `POST
/api/orders/:id/…` routes this section originally sketched are invoked as
`POST /api/actions/orders.refund` and friends.

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/orders/:id` | The whole order: `customer`, `lines`, `refunds`, `fulfillments`, `timeline`, `totals` (plus `downloads` and `licenceKeys`, §18.8) |

| Action | Risk | Notes |
|---|---|---|
| `orders.refund` | high | Partial or full, by line (+ optional shipping) or by amount on un-itemised orders |
| `orders.cancel` | high | Unpaid orders only; releases stock |
| `orders.fulfill` | medium | **Manual only**: status, tracking number, carrier, notify |
| `orders.addNote` | low | Append-only timeline entry, `internal` or `customer` |
| `orders.resendConfirmation` | low | Reports whether a provider accepted the message |

**Orders are now itemised.** `order_lines` snapshots what was sold — title, sku, unit price,
quantity, and the line's **allocated** share of the order's discount and tax — frozen from the
checkout session's `lineSnapshot`, not rebuilt from the catalog. Rebuilding would let a price edit
made during the reservation window produce lines that do not sum to the amount charged. Orders
placed before this return `itemised: false` and an empty `lines` array; nothing is invented for them.

Allocation uses largest-remainder apportionment (`lib/commerce/allocation.ts`) and **sums exactly**
to the order's own totals. A partial refund of a line takes a cumulative slice of its allocation, so
refunding a line in pieces returns precisely its total rather than stranding a rounding remainder.

**The refund meters net sales, not the amount returned** (`docs/PRICING.md` §4.1, D36). A £59
refund containing £4 VAT and £5 postage returns £59 and writes `UsageRecord{type:"refund",
amountMinor:-5000}`. Metering the full £59 would credit the merchant for tax owed to a government
and postage owed to a carrier. The record's environment is **read from the sale**, never
re-derived — a store that went live between the two would otherwise have its reversal metered in an
environment its sale was never counted in. Idempotency is keyed `refund:{refundId}`, which is why
`usage_records` moved off its old `(orderId, type)` unique key: two partial refunds on one order are
two real events, and that key silently dropped the second.

**Markii records refunds; it does not move the money.** `method: "manual"` — the default and
currently the only accepted value — means the merchant issued the refund themselves and is telling
Markii about it; `processorReference` holds the Stripe refund id or the hash of their return
transfer. `method: "processor"` is **refused with the reason**: card refunds need a connected
Stripe account (`lib/payments` reports `configuration_required`), and x402/USDC settlements are
irreversible with no path back from Markii at all (§20). Every refund in the API response carries
`moneyMovedByMarkii: false` so no surface can imply otherwise.

**Restocking** returns units to the **location the stock left from**, recorded on the order line at
completion — not to whichever location is default today. Variant-less products still move the legacy
`products.stock` counter. A line whose product was deleted comes back in `unrestockableLineIds`
rather than being silently skipped.

**Fulfillment is manual and unverified.** Markii does no fulfillment logistics (`docs/PLAN.md` §3),
so `carrier`, `trackingNumber`, and `trackingUrl` are merchant-entered text. Responses carry
`trackingVerified: false`; no surface may present them as confirmed by a carrier.
`fulfillmentStatus` is recomputed from the lines and treats refunded units as no longer outstanding.

**Cancellation is for unpaid orders only.** A paid order is refunded — cancelling one would leave
the shopper's money with the merchant and no record of what is owed.

**Notify is never assumed.** `notifyCustomer` queues merchant mail (SES, the merchant's own domain
— `sendMerchantMail`) as a post-commit effect, so a rolled-back or dry-run action sends nothing. The
action returns `customerNotified: false` / `queued: true`, and the outcome lands on the timeline as
`email_sent` or `email_failed`. SES is not wired yet, so `email_failed` is currently the normal
result and is reported as such.

### 18.8 Digital delivery ✅ LIVE

The **D5 beachhead**. Everything here exists because a merchant selling files never needs the
fulfillment logistics `docs/PLAN.md` §3 permanently excludes — the platform's most conspicuous gap
is irrelevant for this segment.

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/digital-assets` | The org's files, plus measured `usage` against the G5 quotas |
| `POST` | `/api/digital-assets` | Multipart upload to the **private** bucket. Max 2 GB |
| `GET` | `/api/orders/:id` | `downloads` and `licenceKeys` for that order (§18.7) |
| `GET` | `/_sites/:site/download/:token` | **Storefront.** Redeem a grant → 302 to a signed URL |

| Action | Risk | Notes |
|---|---|---|
| `delivery.attachAsset` · `detachAsset` | low | Which files a product delivers. Omit `variantId` for all variants |
| `delivery.deleteAsset` | high | Removes the object. **Past buyers lose access** — reports how many grants it breaks |
| `delivery.setDownloadPolicy` | low | Per-product download cap and expiry. Null means unlimited |
| `delivery.reissueDownload` | medium | Reset the counter, extend expiry, un-revoke |
| `delivery.revokeDownload` | medium | Withdraw access — fraud, chargebacks |
| `delivery.addLicenceKeys` | medium | Load keys into a product's pool. Input is **redacted** from the audit log |

**Upload is a route, not an action.** Actions take JSON and write their input to an audit table;
base64-ing a 2 GB course file through that is not a thing to do. The bytes land on the route;
everything a merchant then *does* with the asset goes through the registry (§22 rule 1).

**The grant is the entitlement; the URL is not.** A `download_grants` row carries the cap, the
expiry, and the revocation. A signed Supabase URL is minted per redemption and lives five minutes.
That separation is what makes a download limit enforceable at all — a URL, once handed out, cannot
be counted or withdrawn. The link in a receipt therefore points at `/download/:token`, never at
storage, or it would be dead before the email was opened.

**Bytes never pass through a route handler** (G5). `/download/:token` authorises, meters, and 302s
with `cache-control: no-store`. Proxying would pay egress twice — Supabase's *and* Vercel's — and
time out a function on a large file; G5 measured a single 2 GB video downloaded 100 times at **$18
of bandwidth against $0.25 of storage**, which is why egress is metered at all.

**Metering is honest about what it counts.** `download_events.bytes` records bytes **authorised**,
not delivered — the transfer happens between shopper and Supabase and is never observable from here.
An abandoned download books a full file. The over-count falls on Markii's own cost accounting, never
on a merchant's bill. G5's quotas are reported as `usage` with `advisoryOnly: true` and **nothing is
blocked on them**, because those numbers are still unsigned-off and cutting off a paying merchant's
customers over an unagreed figure is worse than not gating yet.

**Markii never generates licence keys.** A key it invented would not validate against the merchant's
software. Merchants load their own pool; each sale claims one with `for update skip locked`, so two
concurrent orders cannot be handed the same key. An **exhausted pool does not fail the order** — the
shopper has already paid, irreversibly on the x402 rail — so the shortfall goes on the order timeline
for the merchant to resolve. A refund returns unused keys to the pool rather than burning them.

**A refund revokes the downloads it paid for**, scoped to the refunded lines. Buy, download, refund,
keep the file is the whole digital-goods fraud pattern, and it is closed by default.

**Membership gating is now built — see §18.9.** Subscription-style **recurring** access still is
not: it needs Phase B recurring billing, so a membership is bought for a fixed term and does not
auto-renew.

---

## 18.9 Memberships & gating — ✅ LIVE

A **tier** is an entitlement a store sells. A product may **require** one (only members may view or
buy it) and/or **grant** one (buying it confers the tier). A product that requires the tier it grants
is a renewal, which is why those are two columns rather than one.

### What had to be built first, and was not recorded anywhere

The docs named two blockers for gating — no Phase D content model, no Phase B recurring billing.
**Neither was the real one.** Gating needs to know *who is asking*, and there was no storefront
shopper identity at all: no auth routes under `/_sites/`, nothing ever creating a `customer`-kind
user, and `customers.authUserId` declared and indexed but never read or written. Built on that,
gating would have been a dashboard toggle enforcing nothing.

So §18.3's shopper *login* landed with this section (D34):
`POST /_sites/:site/api/auth/sign-up` · `sign-in` · `sign-out`, and a server-rendered `/account`
page. Three properties are load-bearing:

- **Sign-up stamps `user_kind: "customer"` into `app_metadata`**, which only the service role can
  write. `user_metadata` is user-writable, so a shopper could otherwise promote themselves.
- **A staff account cannot sign in at a storefront**, and the route signs the session back out
  before refusing — otherwise a staff cookie is left on the origin where merchant custom code runs.
- **Authorization resolves through the per-store `customers` row, never `auth.getUser()`** (D32
  mitigation 1). One shopper signed in across two stores is one auth user with two customer records;
  gating on the session alone would hand store A's members access to store B's catalog.

The routes accept a form-encoded body and answer `303`, so the account page needs **no client
JavaScript** — `CLAUDE.md` sanctions only three storefront islands and an account page is not one.

### Status is derived, never stored

There is no `status` column on `customer_memberships`. Nothing in this deployment schedules jobs, so
a stored `"active"` would keep granting access the moment `endsAt` passed, with no sweeper to correct
it — the same constraint that keeps readiness issues unstored and the §4.5 rollup unbuilt. Status is
computed from `startsAt` / `endsAt` / `revokedAt` per request: `active` · `scheduled` · `expired` ·
`revoked`. **`revoked` and `expired` stay distinct** — "the merchant took it away" and "it ran out"
are different answers to a customer complaint.

Renewal **extends the existing row** rather than inserting a second, from whichever is later: now, or
the current expiry. Renewing early therefore never forfeits unused time, and renewing after a lapse
never back-dates into the gap. A lifetime membership (`endsAt: null`) is never shortened into a
finite one by a later purchase.

### Where the gate is enforced

| Point | Behaviour |
|---|---|
| `POST /_sites/:site/api/cart` | Refused, naming the tier — a refusal with no next step is unactionable |
| `POST /_sites/:site/api/checkout/session` | Re-checked **before payment starts**, since a membership can lapse between filling a cart and paying |
| Product page | Renders "Members only" and **omits the buy instructions**, rather than advertising a purchase that will be refused |
| Order completion | Grants conferred tiers **inside the order transaction** |
| `orders.refund` | **Revokes** them, mirroring §18.8's download revocation — closing the fraud pattern for files while leaving it open for memberships would only move the hole |

Checkout completion deliberately does **not** re-check. On the x402 rail settlement is irreversible,
so refusing there would take a shopper's money and decline the goods — the same reasoning that
leaves the §18.5 discount race documented rather than closed by a post-payment refusal.

**Guest checkout cannot receive a membership**, and this is stated rather than silently dropped: a
membership is held by a `customers` row and a guest has none. The order timeline records it for the
merchant to grant by hand.

### Routes

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/memberships/tiers` | `commerce.read`. Member counts are computed per request, and `gatedProductCount` / `grantingProductCount` say how much a tier unlocks and how it is sold |
| `GET` | `/api/customers/:id/memberships` | `commerce.read`. Each row carries a derived `status` |

**Frontend:** `lib/api/memberships.ts` and `/dashboard/memberships` — tiers with live counts, create
and delete, and manual grant/revoke by customer search. A tier nothing sells is badged **Manual
only**, since that usually means a product is missing its `grantsTierId` rather than that it was
intended.

### Actions (§22)

| Action | Permission | Risk | Notes |
|---|---|---|---|
| `memberships.createTier` | `commerce.write` | low | `handle` is slugified and **not editable afterwards** — it may already be in storefront copy |
| `memberships.updateTier` | `commerce.write` | low | Name and description only |
| `memberships.deleteTier` | `commerce.write` | **high** | `products.requires_tier_id` is `on delete set null`, so this **ungates every product behind it** — paid-for content silently becomes public. The result reports `productsUngated` so a confirmation can say it beforehand |
| `memberships.grant` | `commerce.write` | medium | Grants or extends. Refuses a tier from a different store than the customer |
| `memberships.revoke` | `commerce.write` | medium | Access stops immediately; the record survives so history still shows they held it |

### Refunds

A refund revokes the memberships that order conferred, scoped **two ways** so a partial refund does
not over-revoke: only tiers granted by the *refunded lines'* products, and only memberships whose
`orderId` is that order. Refunding a t-shirt from an order that also contained a membership therefore
revokes nothing, and refunding an old order whose membership has since been extended by a newer
purchase leaves the newer one alone.

**Known limit, stated rather than papered over:** refunding a purchase that *extended* a membership
revokes the whole thing, including time paid for by an earlier order. Rolling back precisely would
need the pre-extension expiry stored, which no column holds. Revoking is the merchant-favourable
direction and `memberships.grant` restores it in one call, so this errs the way §18.8 already does.

### Not built

Recurring billing — a membership does not auto-renew — and gating anything other than products:
there is still no CMS content model, which remains Phase D.

---

## 19. Site builder & content 🟡 PLANNED — Phase D

Architecture in **`docs/BUILDER.md`**. Pages are versioned JSON node trees, never HTML strings.

| Method | Route | Notes |
|---|---|---|
| `GET`/`POST` | `/api/pages` | List/create page or template documents |
| `GET`/`PATCH`/`DELETE` | `/api/pages/:id` | Draft edits; `PATCH` bumps draft version |
| `POST` | `/api/pages/:id/publish` | Atomic publish; runs pre-publish checks; invalidates cache tags |
| `GET` | `/api/pages/:id/versions` · `POST /api/pages/:id/versions/:v/restore` | History, diff, restore |
| `POST` | `/api/pages/:id/preview` | Render draft tree → HTML for the canvas/preview link |
| `GET` | `/api/blocks` | Component registry: schemas + editor panel specs (drives the UI) |
| `GET`/`PUT` | `/api/themes/:id` | Theme tokens, global regions, theme CSS |
| `GET`/`POST` | `/api/menus` · `/api/redirects` · `/api/blog/posts` | Navigation, redirects, content |
| `POST` | `/api/media` | Asset upload → media library (supersedes §4's `/api/uploads`) |

Publish response includes check results:

```json
{ "published": true, "version": 12,
  "checks": { "errors": [], "warnings": [
    { "code": "MISSING_ALT", "nodeId": "n_18", "message": "Image has no alt text" },
    { "code": "HEADING_SKIP", "nodeId": "n_22", "message": "h2 followed by h4" } ] } }
```

Errors block publishing; warnings inform. Custom code is sanitized server-side on save and must
never be injectable into `llms.txt`, `agent.md`, `sitemap.xml`, or checkout.

---

## 20. Disputes & chargebacks 🟡 PLANNED — Phase F

Stance and tiering in `docs/PLAN.md` §6. **Visibility is free; assisted response is the add-on;
financial guarantees are not offered.**

```ts
interface Dispute {
  id: string; orderId: number; storeId: number;
  processor: "stripe" | "paypal" | "other";
  reasonCode: string; reason: string;
  amountMinor: number; currency: string;
  status: "needs_response" | "under_review" | "won" | "lost" | "warning_closed";
  evidenceDueBy: string | null;
  evidenceSubmittedAt: string | null;
  paymentRail: "card" | "stripe" | "paypal" | "external";   // x402 never appears here
  openedAt: string;
}
```

| Method | Route | Tier |
|---|---|---|
| `GET` | `/api/disputes` · `/api/disputes/:id` | Included |
| `GET` | `/api/disputes/:id/evidence-checklist` | Included |
| `POST` | `/api/disputes/:id/evidence` | Add-on: auto-assembled packet |
| `POST` | `/api/disputes/:id/submit` | Add-on |
| `GET` | `/api/disputes/stats` | Add-on: win rate, reason breakdown |

**Rail honesty.** x402/USDC settlements are irreversible and have no chargeback path — surface that
plainly in the UI rather than implying uniform dispute coverage across rails. Evidence packets for
agent-originated orders should include the `buyerAuthorization` record from §13, which is often the
strongest response to an "unauthorized transaction" claim.

Never display a projected win probability as a guarantee, and never auto-submit evidence without
explicit merchant confirmation.

---

## 21. Agent Ops add-on 🟡 PLANNED — Phase F (build last)

Full spec, safety model, and endpoint list in **`docs/AGENT-OPS.md`**.

Summary: `/api/agent/chat` (streaming), `/api/agent/sessions`, `/api/agent/proposals/:id/approve|reject`,
`/api/agent/executions/:id/undo`, `/api/agent/audit`, `/api/agent/usage`, `/api/agent/settings`.

Three contract rules that belong here rather than only in the spec:

1. **Agent tools call `/api/*`, never `lib/db`** — the agent gets exactly the human's permissions,
   validation, and audit trail, with no privileged path and no duplicated business rules.
2. **Every mutation is a proposal first.** High-risk capabilities (pricing, discounts, publishing,
   bulk edits, channel config) cannot be configured to auto-execute.
3. **Retrieved content is data, never instruction.** Product descriptions, imported catalogs,
   customer notes, and form submissions are untrusted input; tool authorization never depends on
   anything the model read.

---

## 22. Action registry & MCP — ✅ LIVE (registry) / 🟡 PLANNED (undo, MCP)

Markii is **agent-native**: humans and agents operate the product through the same actions,
permissions, and audit trail. Architecture in `docs/BUILDER.md` §2–3. This section is the contract.

**The registry primitive lands in Phase C, with the first commerce mutations** (revised
2026-07-29) — not with the builder in D, and certainly not with the chat UI in F. Agent-nativeness
cannot be retrofitted onto a mutation layer that assumed a single UI caller, and routing Phase C's
mutations through the registry from the start avoids refactoring every one of them later. Phase D
adds builder actions and the MCP server on top; Phase F adds the chat product. See
`docs/BACKEND.md` §1.

### Status — ✅ LIVE (registry, invoke, dry-run, audit)

**As of 2026-07-31 the registry is wired end to end.** `GET /api/actions` (filtered to what the
caller may invoke), `POST /api/actions/:id` (with `?dryRun=1`), and `GET /api/actions/invocations`
are live. **39 actions are defined** across `lib/actions/definitions/` — `catalog.*`,
`collections`, `customers.*`, `delivery.*`, `discounts.*`, `email.*`, `inventory.*`, `orders.*`,
`readiness.updateIssues`, `shipping.*`, and `tax.updateSettings` — and they are the **only** way
those mutations happen.

**Note the invoke response is `dryRun`, not `auditId`** (`lib/actions/types.ts`): the JSON example
below predates the implementation on that field. The frontend client is `lib/api/actions.ts`.

Verified behaviour: a dry run returns the full diff and writes nothing (not even an audit row);
failures are audited while dry runs are not; an `analyst` token is refused a write action **and**
does not see it in the registry listing; cross-tenant invocation is a `404`; and each org's audit
log contains its own invocations only, including its own refused attempts.

Undo (`POST /api/actions/:id/undo`) and the MCP server remain planned. `catalog.updateVariant` and
`inventory.adjust` are marked `undoable` because their inverse is well-defined — the endpoint to
apply it is not built yet.

### Historical note — why the primitive shipped before the routes

**The `defineAction` primitive exists** in [`lib/actions/`](../lib/actions/) as of 2026-07-30, with
its audit table (`action_invocations`, migration `0001`). What it provides today:

- `defineAction` / `getAction` / `allActions` / `describeAction` — the registry, with `input`
  exported as JSON Schema so an agent can call an action it has never seen.
- `invokeAction(id, input, { actor, dryRun })` — one pipeline: permission check → zod parse →
  transactional run → audit write. **Dry run is the real action inside a transaction that is rolled
  back**, not a parallel "what would happen" implementation, because a second implementation drifts
  from the first and a proposal that does not match its execution is worse than no proposal.
- `ctx.effect()` — side effects the database cannot roll back (email, Stripe) queue here and flush
  only after commit, so a rolled-back or dry-run action never sends anything.
- Authorization is **injected** via `setAuthorizationResolver`. Until Phase A installs the real one,
  the resolver **denies everything**.

**Not built yet, and deliberately:** there are **no action definitions**, and the endpoints below
are unrouted. Both wait on §16 — every one of them needs an actor to authorize, so shipping them
today would mean routes that can only answer 401. The first definitions land with Phase C's commerce
mutations, which is the whole reason the primitive was built ahead of them.

**Existing §1–8 routes still mutate directly.** They are converted in Phase A, which re-scopes every
one of them for tenancy anyway — doing it twice would be the more expensive path.

### The primitive

An action is defined once and becomes every surface at once — UI mutation, HTTP endpoint, agent
tool, MCP tool, CLI:

```ts
defineAction({
  id: "builder.setNodeStyle",
  description: string,             // written for an agent as much as a human
  input: ZodSchema,                // single source of validation truth, everywhere
  permission: "cms.write",         // checked server-side regardless of caller
  riskTier: "read" | "low" | "medium" | "high",
  undoable: boolean,               // records an inverse; powers human undo AND agent rollback
  run(input, ctx): Promise<Result>,
});
```

### Endpoints

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/actions` | Registry: id, description, JSON schema, permission, risk tier. Filtered to what the caller may invoke |
| `POST` | `/api/actions/:id` | Invoke. Same validation, permissions, and audit for every caller |
| `POST` | `/api/actions/:id?dryRun=1` | Return the diff an invocation *would* produce, without writing. A **query flag on the invoke route**, not a `/dry-run` sub-path — one handler, so the preview cannot drift from the execution |
| `POST` | `/api/actions/:id/undo` | Invert a prior invocation by `invocationId`, when `undoable` |
| `GET` | `/api/actions/invocations` | Audit trail: actor (`user` \| `agent` \| `token`), input, result, `occurredAt` |
| `ALL` | `/api/mcp` | MCP server: registry as tools, store/page context as resources |

Invocation response:

```json
{ "invocationId": "inv_8f2a", "ok": true, "result": { },
  "diff": [ { "entity": "page", "entityId": "pg_1", "path": "tree.n_18.styles.sm.paddingY",
              "before": "8px", "after": "24px" } ],
  "undoable": true, "auditId": "aud_411" }
```

### Contract rules

1. **Actions are the only mutation path.** No route handler mutates state directly — otherwise the
   agent and the UI drift apart, which is the failure mode this whole design exists to prevent.
2. **`dry-run` is how proposals are built.** The agent proposal flow (§21, `docs/AGENT-OPS.md`) is
   `dry-run` → render diff → human approves → invoke. No separate proposal engine.
3. **Risk tier governs execution, not the caller's confidence.** `high` actions (publishing,
   pricing, discounts, custom code, bulk edits) always require human approval and cannot be
   configured to auto-run.
4. **Identical permissions for humans, agents, and tokens.** An agent can never do something the
   staff member behind it could not.
5. **Every invocation is audited** with actor identity, whether it came from a click, a chat turn,
   an MCP client, or CI.
6. **MCP tokens are scoped and role-bound** (§16), never a user's session cookie.

---

## 23. Storefront routes (FYI — do not build these)

Owned by the backend; listed so the frontend can link to them (e.g. "view live site",
preview tabs):

| URL (on the site's domain) | What it serves | Status |
|---|---|---|
| `/` | server-rendered HTML catalog | ✅ LIVE |
| `/c/{categorySlug}` | category page | ✅ LIVE |
| `/p/{productSlug}` | product page + JSON-LD | ✅ LIVE |
| `/llms.txt` | LLM-readable store summary | ✅ LIVE |
| `/agent.md` | agent protocol + purchase instructions | ✅ LIVE |
| `/sitemap.xml` | sitemap | ✅ LIVE |
| `/api/checkout` | x402 payment endpoint (402 challenge → settle) | ✅ LIVE |
| `/api/cart*` · `/api/checkout/session*` | cart + checkout API | ✅ LIVE (§18.4) — x402 rail; card rail PLANNED |
| `/cart` · `/checkout` | human cart + checkout **pages** | 🟡 PLANNED (§18.4) — the API exists; the storefront islands do not |
| `/collections/{handle}` | merchandising collection page | 🟡 PLANNED (§18.2) |
| `/blog` · `/pages/{handle}` | builder-authored content | 🟡 PLANNED (§19) |
| `/account` | customer account area | 🟡 PLANNED (§18.3) |

In local dev, storefronts are reachable at `http://localhost:3000/_sites/{siteSlug}/…`.

---

## 24. Email — sending domains, deliverability, suppression — partial ✅/🟡

Transport, templates, and the suppression list are ✅ LIVE. **No mail is sent from this
deployment**, because AWS SES has no credentials here — every send is recorded as
`not_configured` and no surface claims otherwise.

**Two streams, split by whose mail it is, and the split is load-bearing** (`CLAUDE.md`, G1):

| Stream | Provider | Carries | From |
|---|---|---|---|
| Merchant | **AWS SES** | order confirmations, shipping and refund notices, cancellations, digital delivery | the merchant's **own verified domain** |
| Platform | **Resend** | staff auth, invoices, dunning, contact form, platform notices | `markii.shop` |

**Merchant mail never falls back to Resend.** A merchant's order confirmation leaving from
`markii.shop` would put their bounces on Markii's sending reputation, which is the entire reason
the two streams exist. Without a verified domain, merchant mail does not send.

### `GET /api/settings/email` — ✅ LIVE (`org.read`)

```ts
{
  customerEmail: {
    canSend: boolean;
    code: "ready" | "configuration_required" | "domain_verification_required";
    message: string;
    senderAddress: string | null;
  };
  domains: {
    id: number;
    domain: string;
    senderAddress: string;          // `${fromLocalPart}@${domain}`
    fromName: string | null;
    replyTo: string | null;
    status: "pending" | "verified" | "failed" | "temporary_failure";
    verifiedAt: string | null;
    lastCheckedAt: string | null;
    problem: string | null;
    /** The CNAMEs to publish. Derived from SES's current tokens, never stored. */
    dns: { type: "CNAME"; name: string; value: string }[];
  }[];
  suppressions: {
    email: string;
    reason: "bounce" | "complaint" | "manual";
    detail: string | null;
    createdAt: string;
    /** False for complaints — the recipient's decision, not the merchant's. */
    removable: boolean;
  }[];
  platformEmail: { status: "ready" | "configuration_required"; scope: string };
  providerConfigured: boolean;      // false ⇒ nothing above can work yet
}
```

`customerEmail.code` distinguishes **whose problem it is**: `configuration_required` is Markii's
(no AWS credentials), `domain_verification_required` is the merchant's. `platformEmail` is reported
separately and must never be merged into one "email: OK" — a merchant whose password reset arrived
would otherwise conclude their order confirmations work, and they do not.

### Actions (§22) — ✅ LIVE

| Action | Permission | Risk | Notes |
|---|---|---|---|
| `email.addSendingDomain` | `org.write` | medium | Registers with SES and returns the DKIM CNAMEs. Refuses rather than writing a row with no tokens — a merchant cannot act on a verification step with no records to publish. A **dry run does not contact AWS**: creating an SES identity is a durable side effect no rollback can withdraw. |
| `email.verifySendingDomain` | `org.write` | low | Re-reads status from SES. Pull, not push — nothing in this deployment schedules jobs. An unreachable AWS is *reported*, not thrown, and never downgrades a verified domain. |
| `email.removeSendingDomain` | `org.write` | **high** | Silently stops every customer email. Nothing errors; customers simply stop hearing from the store. |
| `email.suppressAddress` | `commerce.write` | low | Manual entry. Lowercased at write. |
| `email.unsuppressAddress` | `commerce.write` | medium | **Refuses for `complaint`.** That consent was withdrawn by the recipient; re-enabling it from a dashboard button would put an AWS policy violation one click away. |

### `POST /api/webhooks/ses` — ✅ LIVE (unauthenticated, signature-verified)

SES bounce and complaint events over SNS. **Not an action** (§22): there is no actor and no org on
the request, and the write it causes is a platform-safety record rather than a merchant mutation.

Verification is a real security boundary, not hygiene. An unverified endpoint here is a *remote
suppression button* — fabricated complaints would silently stop a merchant mailing their own
customers, and the damage would look exactly like a deliverability problem. So:

- The SNS signature is checked against the certificate SNS names, and **the certificate URL is
  host-validated before it is fetched** (`^sns\.[a-z0-9-]+\.amazonaws\.com$`). A signature check
  that downloads its own trust anchor from an attacker-supplied URL verifies nothing and doubles
  as SSRF. Unverified messages get `403`.
- **Only `Permanent` bounces suppress.** A `Transient` bounce is a full mailbox or a greylisting
  server; suppressing on those would permanently cut off a paying customer for a problem that
  fixes itself.
- Events are attributed to an org through `email_deliveries.providerMessageId`. An event that
  cannot be attributed is **dropped, never applied globally** — guessing wrong silences a
  merchant's mail to a customer who never complained about them.
- Once the signature verifies, the answer is always `200`. SNS retries a non-2xx for an hour then
  disables the subscription, and losing every future bounce because one lookup failed is far worse
  than dropping one event.

### What still needs AWS, not code

1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`.
2. **Sandbox escape** — a support request with a queue in front of it. Until granted, SES accepts
   mail only to verified addresses. **Start it early; it is refusable.**
3. A configuration set with an SNS destination pointing at `/api/webhooks/ses`
   (`SES_CONFIGURATION_SET`). Without it SES still sends, nothing is ever suppressed, and the
   account drifts toward a bounce-rate suspension unseen.
4. Per-merchant domain verification — a product feature, and the merchant's own task.

**Frontend:** `lib/api/email.ts` and `/dashboard/settings/email` (added 2026-08-02). The screen is
what `lib/email/`'s own copy — "Verify a sending domain in Settings → Email" — points at; before it
existed that instruction led nowhere. It renders the two streams separately, and **hides the
add-domain form entirely when `providerConfigured` is false** rather than offering one that AWS
would reject after the merchant filled it in.

**Not built:** shopper auth mail via Supabase's Send Email Hook, Secure Email Change's two-message
flow, abandoned-cart mail, and broadcast/campaign sending.

---

## Build-order notes

**§1–8 are built.** Seed data (3 sites, ~30 products, categories, orders + traffic) ships via
`pnpm db:seed`, so every live list/analytics/finances screen renders non-empty.

Remaining order follows the v3 phases in `docs/PLAN.md` §7 — **not** the section numbering here:

| Phase | Sections | Why this order |
|---|---|---|
| **A** | §16 | Auth/orgs block everything; every existing route becomes org-scoped |
| **B** | §17 | Metering must be designed into the order pipeline, not retrofitted over it |
| **C** | §18, §13, **§22 registry** | Cart, checkout, variants, customers — the actual commerce gap. Build `defineAction` here so mutations never need refactoring later |
| **D** | §19 + §22's MCP server | Builder actions and MCP on top of the registry already built in C |
| **E** | §9–12, §14, §15 | The AI layer, on top of a real platform |
| **F** | §20, then §21 | Chargeback Assist, then the Agent Ops chat product **last** |

**Frontend rule while any of this is pending:** define the typed service in `lib/api/*` with the
method names from `docs/PLAN.md`, and render *configuration required* / *not yet measured* /
*coming soon*. Do not add fixtures, mock route handlers, or placeholder numbers.

**Money rule, everywhere:** integer minor units, explicit currency on every amount, no float math,
and `Minor`-suffixed field names on all new fields. §1–8 use the older `Cents` suffix — leave those
alone rather than churning a live contract.
