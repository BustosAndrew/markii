# CLAUDE.md

Markii — agent-native, multi-tenant e-commerce platform built during a 4-hour hackathon.
Merchants import catalogs; Markii serves machine-readable storefronts (HTML + JSON-LD,
`llms.txt`, `agent.md`) that AI agents buy from via x402 (USDC, Base Sepolia).

## Commands

```bash
pnpm dev        # dev server (Turbopack)
pnpm build      # production build — run before considering work done
pnpm lint       # eslint
pnpm db:push    # push Drizzle schema to Neon (needs DATABASE_URL in .env.local)
pnpm db:seed    # seed demo data (3 sites, ~30 products, orders, traffic)
```

Package manager is **pnpm** (v11; build-script approvals live in `pnpm-workspace.yaml`).

## Current status

**Backend is complete**: DB layer (Neon + Drizzle, `lib/db/`), every `/api/*` route,
storefront renderer (`app/_sites/[site]/`), host-routing proxy (`proxy.ts`), x402 checkout,
importer, and seed script. Requires `DATABASE_URL` in `.env.local` (see `.env.example`);
until then DB-backed endpoints return 500.

**Dashboard UI is built** (`app/(dashboard)/`) against **`docs/API.md`** — call those
endpoints only, never `lib/db` / Drizzle from frontend screens. Landing page uses the
light brand system (`DESIGN.md`). Route map and data model live in `docs/PLAN.md`.

## Architecture

- `app/api/` — dashboard REST API (contract: `docs/API.md`)
- `app/(dashboard)/` — admin UI (sites, inventory, analytics, finances, integrations)
- `app/%5Fsites/[site]/` — multi-tenant storefront renderer + `llms.txt` / `agent.md` /
  `sitemap.xml` / `api/checkout` (x402) routes. **The folder must stay `%5Fsites`**: a
  literal `_sites` is a Next.js *private folder* and is dropped from routing entirely
  (every storefront 404s). `%5F` is the documented escape hatch; the public URL is
  still `/_sites/{slug}/…`.
- `proxy.ts` — Host-header → site rewrite (platform hosts pass through; `{slug}.{ROOT_DOMAIN}`,
  `{slug}.localhost`, custom domains → `/_sites/[slug]`)
- `lib/` — Drizzle schema (`db/`), api helpers, queries/serializers, importer, x402,
  generators, integrations, storefront loader; FE-only client helpers under `lib/api/`

## Rules

- **Storefront pages (`_sites/`) are server-rendered minimal HTML** — never add `"use client"`,
  heavy bundles, or client state there. Dashboards can be client-rich.
- Validate product input with **zod** before generating HTML or JSON-LD; type JSON-LD with
  `schema-dts`.
- Importers try Shopify `/products.json` → WooCommerce Store API → cheerio sitemap fallback;
  wrap every external fetch in try/catch.
- Stripe is an **optional** integration — plan for it on the integrations page, don't put it in
  the core payment path (x402 is the core).
- Dashboard FE treats upload `url` values as opaque (Vercel Blob in prod, `public/uploads` in
  dev per `docs/API.md`).

## Brand

Gradient bag-bot logo (`components/logo.tsx`, `app/icon.svg`). **Light theme**
(see `DESIGN.md` / visual design plan): canvas `#FAFAFA`, cards `#FFFFFF`, text
`#16161D`. Logo gradient `#590D22` → `#FF758F`; UI accent `#C9184A` reserved for
logo, primary CTAs, active nav, status, and charts — not decorative chrome.
Use `.text-gradient` / `.bg-gradient-brand` sparingly for brand-only accents.
