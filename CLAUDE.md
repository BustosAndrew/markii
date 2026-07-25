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
importer, and seed script. The **dashboard UI (`app/(dashboard)/`) is not built** — it is
owned by a separate frontend agent, whose source of truth is **`docs/API.md`** (the full
API contract). Frontend work must call those endpoints only, never `lib/db` directly.
Landing page (`app/page.tsx`) exists. Requires `DATABASE_URL` in `.env.local`
(see `.env.example`); until then DB-backed endpoints return 500.

## Architecture

- `app/api/` — dashboard REST API (contract: `docs/API.md`)
- `app/(dashboard)/` — admin UI (sites, inventory, analytics, finances, integrations) — TODO
- `app/_sites/[site]/` — multi-tenant storefront renderer + `llms.txt` / `agent.md` /
  `sitemap.xml` / `api/checkout` (x402) routes
- `proxy.ts` — Host-header → site rewrite (platform hosts pass through; `{slug}.{ROOT_DOMAIN}`,
  `{slug}.localhost`, custom domains → `/_sites/[slug]`)
- `lib/` — Drizzle schema (`db/`), api helpers, queries/serializers, importer, x402,
  generators, integrations, storefront loader

## Rules

- **Storefront pages (`_sites/`) are server-rendered minimal HTML** — never add `"use client"`,
  heavy bundles, or client state there. Dashboards can be client-rich.
- Validate product input with **zod** before generating HTML or JSON-LD; type JSON-LD with
  `schema-dts`.
- Importers try Shopify `/products.json` → WooCommerce Store API → cheerio sitemap fallback;
  wrap every external fetch in try/catch.
- Stripe is an **optional** integration — plan for it on the integrations page, don't put it in
  the core payment path (x402 is the core).

## Brand

Gradient bag-bot logo (`components/logo.tsx`, `app/icon.svg`). Dark theme.
Palette (CSS vars in `app/globals.css`): deep magenta `#8e1148` → pink `#e01b7b` →
orange `#f98443` / amber `#f9a03f`; background `#0b0510`, surface `#150a1c`.
Use the `.text-gradient` / `.bg-gradient-brand` utilities for brand accents.
