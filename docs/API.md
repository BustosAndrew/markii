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
| 9 | Readiness & catalog health | 🟡 PLANNED | E |
| 10 | Channels | 🟡 PLANNED | E |
| 11 | Product agent-data extension | 🟡 PLANNED | E |
| 12 | Agent Test Lab | 🟡 PLANNED | E |
| 13 | Orders (promoted) | partial — `GET /api/orders/:id` is LIVE, the rest PLANNED | C |
| 14 | Analytics v2 (funnel, channels, failures) | 🟡 PLANNED | E |
| 15 | Automations, activity, notifications, team | 🟡 PLANNED | E |
| 16 | Accounts, organizations, staff | partial — `/api/auth/*`, `/api/me`, `/api/org`, `/api/org/staff*`, and **org scoping of §1–8** are ✅ LIVE; audit, sessions, tokens, MFA, org switching PLANNED | **A** |
| 17 | Billing, plans, metering, threshold fees | 🟡 PLANNED | B |
| 18 | Commerce core (variants, inventory, collections, customers, cart, checkout, discounts, tax, shipping) | partial — §18.1 variants/inventory, §18.2 collections, §18.3 customers ✅ LIVE (writes via §22 actions); §18.4–18.6 PLANNED | C |
| 19 | Site builder & content | 🟡 PLANNED | D |
| 20 | Disputes & chargebacks | 🟡 PLANNED | F |
| 21 | Agent Ops add-on | 🟡 PLANNED | F (last) |
| 22 | **Action registry & MCP** — agent-native architecture | ✅ LIVE (registry, invoke, dry-run, audit; 4 actions). Undo + MCP server PLANNED | **Registry: C · MCP: D** |

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
Stored in **Supabase Storage** in production (local `public/uploads` in dev) — either way, treat
the returned `url` as **opaque**. That rule is why the storage backend can change without any
frontend edit. (External image URLs can also be used directly without uploading.)
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

## 9. Readiness & catalog health 🟡 PLANNED

Service: `ReadinessService` — `getOverview`, `getIssues`, `getHistory`, `resolveIssue`,
`dismissIssue`. Powers the Overview score card and `/dashboard/health`.

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

### `POST /api/readiness/issues/bulk`
Bulk actions from the health table.

```json
{ "ids": ["iss_1", "iss_2"], "action": "resolve" | "dismiss" | "assign", "assignee": "user_1" }
```

→ `200` `{ "updated": 2, "issues": [ ReadinessIssue, ... ], "failed": [] }`

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

`state`: `"complete" | "partial" | "empty" | "conflict"`.

**Scope note:** the first version may compute scores client-side from real `/api/products` data.
That is honest (it is derived from the merchant's actual catalog). Persisted resolve/dismiss and
score history require these endpoints.

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

## 13. Orders (promoted from Finances) — partial

`GET /api/orders/:id` is ✅ LIVE (§7). The list, timeline, and the extended fields below are
🟡 PLANNED. Service: `OrderService` — `listOrders`, `getOrder`, `getTimeline`.
Settlement history moves under Orders as a tab (FR-OR-06); §7's finances endpoints stay live and
back it.

### Extended Order entity

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

### `GET /api/orders`
Query: `q`, `siteId`, `channelId`, `paymentRail`, `paymentStatus`, `fulfillmentStatus`,
`status`, `exception` (`true` = only orders with an exception), `environment`, `from`, `to`,
`page`, `limit`, `sort` (`-createdAt|amountCents`).
→ paginated **Order** + `"totals": { "amountCents": 152300, "orderCount": 87 }`.

### `GET /api/orders/:id/timeline`

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

### `GET /api/orders/export`
Same filters as the list. → `text/csv`.

Operational mutations (refund, cancel, mark fulfilled) are an **open decision** — Orders is
read-only until that is settled. Do not build mutation controls yet.

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

## 17. Billing, plans, metering, threshold fees 🟡 PLANNED — Phase B

Full model in **`docs/PRICING.md`**. Processor: Stripe Billing (subscriptions) + Stripe Connect
(merchant payouts). Markii never holds merchant funds.

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
| `POST` | `/api/webhooks/stripe` | Signature-verified, idempotent, retry-safe |

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

**Contract rules.** `billableThisPeriodMinor` uses the marginal formula in `docs/PRICING.md` §3.3 —
only the slice above the threshold, never the whole period. Projections are always labeled as
projections and never presented as owed. Before a first sale exists, values are `null` and the UI
shows *not yet measured*, never `0`. Trial orgs see accrual with "would have been charged" framing.
`upgradeSuggestion` is surfaced even when it lowers Markii's revenue.

---

## 18. Commerce core 🟡 PLANNED — Phase C

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
> `GET /api/customers/:id/orders`. Writes via §22 actions: `customers.create`,
> `customers.update`, `customers.addAddress`, `customers.delete`.
>
> **A customer record is not a login.** Guest checkout creates a customer with no `authUserId`; an
> account links one later. `customers.authUserId` points at `auth.users` (D32 — one project) with no
> foreign key, since that schema belongs to `supabase_auth_admin`. Shopper *authentication* arrives
> with checkout (§18.4).
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

### 18.4 Cart & checkout

**The single biggest gap** — today only agent-driven x402 checkout exists.

```ts
interface Cart {
  id: string; storeId: number; token: string;
  lines: { variantId: number; quantity: number; unitPriceMinor: number;
           addOnIds?: number[] }[];
  customerId: number | null; email: string | null;
  discountCodes: string[];
  subtotalMinor: number; discountMinor: number; taxMinor: number;
  shippingMinor: number; totalMinor: number; currency: string;
  shippingAddress: Address | null; shippingRateId: string | null;
  status: "open" | "abandoned" | "converted";
  expiresAt: string;
}
```

| Method | Route | Notes |
|---|---|---|
| `POST` | `/api/storefront/cart` | Create cart |
| `GET`/`PATCH` | `/api/storefront/cart/:token` | Read, add/update/remove lines |
| `POST` | `/api/storefront/cart/:token/discount` | Apply/remove code |
| `POST` | `/api/storefront/cart/:token/shipping-rates` | Quote rates for an address |
| `POST` | `/api/storefront/checkout` | Start checkout → Stripe PaymentIntent/Checkout Session |
| `POST` | `/api/storefront/checkout/:id/complete` | Confirm → reserve inventory → create Order → **write UsageRecord (§17)** |

Prices, discounts, tax, and totals are **always recomputed server-side** at checkout — never trust
client-supplied amounts. Inventory is reserved at payment authorization and released on
expiry/failure. Card data goes to Stripe-hosted elements only (PCI SAQ-A). The x402 agent checkout
in `app/%5Fsites/[site]/api/checkout/` remains a peer path into the same order pipeline and must
write the same usage records.

### 18.5 Discounts & gift cards

`Discount { id, code | automatic, type: "percentage"|"fixed"|"free_shipping"|"bogo", valueMinor |
percentage, appliesTo: {scope, ids[]}, minimumSubtotalMinor, customerEligibility, usageLimit,
usageLimitPerCustomer, usedCount, combinesWith: {product, order, shipping}, startsAt, endsAt,
status }`

`GET`/`POST` `/api/discounts`, `GET`/`PATCH`/`DELETE` `/api/discounts/:id`,
`POST /api/discounts/validate`. Gift cards: `/api/gift-cards` — issue, check balance, redeem
(count toward net sales at **redemption**, not purchase — see `docs/PRICING.md` §3.1).

### 18.6 Tax & shipping rates

Rate *configuration*, not logistics. `GET`/`PUT` `/api/settings/tax` (provider config, nexus,
product tax codes, prices-include-tax flag), `POST /api/tax/calculate`;
`GET`/`POST` `/api/shipping/zones` and `/api/shipping/rates` (flat, weight-based, price-based,
free-over-threshold).

Out of scope: carrier rate shopping, label purchase, tracking sync (`docs/PLAN.md` §3).

### 18.7 Order operations

Extends §13. `POST /api/orders/:id/refund` (partial/full, restock flag → inventory ledger +
`UsageRecord{type:"refund"}`), `POST /api/orders/:id/cancel`,
`POST /api/orders/:id/fulfillment` (**manual only**: status, tracking number, carrier name, notify
customer), `POST /api/orders/:id/notes`, `POST /api/orders/:id/resend-confirmation`.

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

## 22. Action registry & MCP 🟡 PLANNED — Phase D (architecture, not a feature)

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
are live. Four actions are defined — `catalog.setProductOptions`, `catalog.updateVariant`,
`inventory.adjust`, `inventory.createLocation` — and they are the **only** way those mutations
happen.

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
| `POST` | `/api/actions/:id/dry-run` | Return the diff an invocation *would* produce, without writing |
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
| `/cart` · `/checkout` | human cart + Stripe-hosted checkout | 🟡 PLANNED (§18.4) |
| `/collections/{handle}` | merchandising collection page | 🟡 PLANNED (§18.2) |
| `/blog` · `/pages/{handle}` | builder-authored content | 🟡 PLANNED (§19) |
| `/account` | customer account area | 🟡 PLANNED (§18.3) |

In local dev, storefronts are reachable at `http://localhost:3000/_sites/{siteSlug}/…`.

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
