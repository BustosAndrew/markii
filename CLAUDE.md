# CLAUDE.md

Markii — agent-native, multi-tenant e-commerce platform built during a 4-hour hackathon.
Merchants import catalogs; Markii serves machine-readable storefronts (HTML + JSON-LD,
`llms.txt`, `agent.md`) that AI agents buy from via x402 (USDC, Base Sepolia).

## Commands

```bash
pnpm dev        # dev server (Turbopack)
pnpm build      # production build — run before considering work done
pnpm lint       # eslint
```

Package manager is **pnpm** (v11; build-script approvals live in `pnpm-workspace.yaml`).

## Current status

Only the **landing page** (`app/page.tsx`) exists. `/dashboard` is linked but not built.
The full route map, data model, and hour-by-hour plan are in `docs/PLAN.md` — follow it,
build in that order, and leave the "save for last" list for the end.

## Architecture (planned)

- `app/(dashboard)/` — admin UI (sites, inventory, analytics, finances, integrations)
- `app/_sites/[site]/` — multi-tenant storefront renderer + `llms.txt` / `agent.md` /
  `api/checkout` (x402) routes
- `middleware.ts` — Host-header → site rewrite (`app.*` → dashboard, else `/_sites/[siteId]`)
- `lib/` — Drizzle schema (`db/`), importer, x402 helpers, generators, vercel/GMC wrappers

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
