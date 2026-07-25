# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are merchants and store operators. They import or create a catalog, deploy agent-readable storefronts, and monitor agent traffic and payouts from an admin dashboard.

## Product Purpose

Markii turns a merchant catalog into machine-readable storefronts (HTML + JSON-LD, `llms.txt`, `agent.md`) that AI agents can crawl and purchase from via x402 (USDC on Base Sepolia). Success means a merchant can go from catalog → live agent storefront → visible traffic and settled orders without building agent infrastructure themselves.

## Positioning

Infrastructure for agentic commerce — the calm, trustworthy admin and storefront layer that makes catalogs purchasable by agents — not a traditional consumer shopping site.

## Operating Context

- Merchants work in a Next.js admin dashboard (`/dashboard/*`).
- Storefronts and payment settlement are served separately (teammate-owned); the dashboard links to live storefront URLs and consumes dashboard APIs only.
- Catalog entry via CSV upload, URL scrape (Shopify / WooCommerce / fallback), or manual product/category forms.
- Demo/hackathon context: no multi-user auth; single-tenant admin.

## Capabilities and Constraints

**In scope for this frontend work**

- Marketing landing and full admin dashboard UI per `docs/PLAN.md` and the frontend PDF brief.
- Call only endpoints defined in `docs/API.md` (relative `/api/*`). Never import or query Drizzle / `lib/db` from dashboard code.
- Do not build `app/_sites/**`, host middleware, importers, x402 settlement, or other backend modules.

**Data access**

- Use real `/api/*` only. No client mocks and no temporary mock route handlers. Screens must handle loading, empty, and error states until the backend is available.

**Confirmed product surfaces (dashboard)**

- Overview, inventory, categories, products, websites (list / create wizard / detail), analytics, finances, integrations (x402 wallet, Google Merchant Center, optional Stripe).
- Import popup with allocate-then-commit; create-site wizard with live HTML / `llms.txt` / `agent.md` / sitemap previews and template autofill.

**Undecided / out of contract**

- In-product AI chat assistant is mentioned in visual notes but has no API in `docs/API.md` — do not build until contracted.
- AuthN/AuthZ remains none for the hackathon; do not invent a login flow.

## Brand Commitments

- Product name: **Markii**; bag-bot logo asset in `components/logo.tsx` / `app/icon.svg`.
- Binding visual direction (user-supplied): `/Users/Lonestar/Downloads/visual-design-plan.md` — light neutral UI (`#FAFAFA`), logo gradient reserved for brand mark and key actions, “Vercel / Stripe of AI commerce” posture. Current dark landing tokens are incumbent evidence only under redesign.
- Voice: calm, premium, technical, developer-first / infrastructure — not retail marketplace chrome.

## Evidence on Hand

- `docs/PLAN.md` — architecture, route map, timeline.
- `docs/API.md` — dashboard API contract v1 (source of truth for FE↔BE).
- `/Users/Lonestar/Downloads/markii.pdf` — frontend surface checklist (3 pages).
- `/Users/Lonestar/Downloads/visual-design-plan.md` — palette, components, accent rules.
- Existing runnable landing at `app/page.tsx` (dark theme; to be replaced under the binding visual plan).
- No real customer testimonials, benchmarks, or production metrics — do not fabricate them.

## Product Principles

1. Merchant job first: every dashboard screen should advance import → deploy → monitor → get paid.
2. Contract honesty: UI shapes and fields match `docs/API.md`; no invented endpoints or client-side persistence of secrets beyond the form submit.
3. Color means something: brand color for action, AI/status, and identity — not decoration.
4. Storefronts stay machine-first; the dashboard is where humans operate.
5. Degrade gracefully: empty and error states are first-class until APIs exist.

## Accessibility & Inclusion

No product-specific standard was set beyond baseline web accessibility (keyboard, contrast on the light UI, reduced-motion respect). Treat WCAG-minded defaults as the floor.
