# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are merchants and store operators — unchanged across every direction shift. Roles the UI must serve: merchant owner (performance, risk, revenue, cost, required actions), catalog manager (products, variants, inventory, data quality), e-commerce manager (merchandising, discounts, channels, conversion), developer/integrator (custom code, templates, protocol config, debugging), operations manager (orders, refunds, exceptions, disputes), and analyst/viewer (read-only review and export).

The target merchant is one who finds Shopify or Squarespace too expensive for their volume, or who wants a storefront AI shopping agents can actually use.

## Product Purpose

Markii is a **commerce platform** in the Shopify/Squarespace category: a merchant builds a store with a drag-and-drop site builder, manages catalog and inventory, sells to human shoppers through a real checkout, and gets paid through their own payment provider.

Two things separate it from the incumbents:

1. **No penalty for using your own payment provider, and no cut of digital goods.** Shopify and BigCommerce each charge up to 2% for using a processor that isn't theirs, from the first sale; Squarespace charges 5% on digital content and memberships until $99/mo (verified 2026-07-29, `docs/COMPETITORS.md`). Markii charges 0% on any processor and 0% on digital, on every plan — plus no Markii transaction fee at all until a merchant crosses an annual sales threshold, then only on the portion above it, with no forced plan upgrade.
2. **Storefronts AI agents can read and buy from.** Semantic HTML, JSON-LD, `llms.txt`, `agent.md`, an Agent Readiness Score, and agent-originated order tracking — built in rather than bolted on.
3. **An agent-native admin.** Every capability is one shared action serving the human UI, the API, agent tools, and an MCP server alike — so a merchant can edit visually while a developer drives the same store from Claude Code, under identical permissions and audit trail.

Optional add-ons extend it: a chat-driven ops agent that runs inventory and storefront changes, and assisted chargeback response.

Success means a merchant can build a store, sell to humans and agents, and understand exactly what they pay — without outgrowing the platform's pricing or hitting a wall on what they can customize.

## Positioning

A commerce platform, not an AI product and not a crypto storefront builder. The AI-legibility layer is the differentiator, not the identity; x402/USDC is one optional payment rail beside card, Stripe, and PayPal. Calm, premium, technical, honest about cost.

**Not** competing on: fulfillment logistics, POS/in-person retail, or a third-party app marketplace — see `docs/PLAN.md` §3.

## Operating Context

- Merchants work in a Next.js admin dashboard (`/dashboard/*`); shoppers and AI agents hit multi-tenant storefronts on subdomains or custom domains.
- Catalog entry via CSV upload, URL scrape (Shopify / WooCommerce / fallback), or manual forms.
- Payments settle through the merchant's own provider (Stripe Connect and peers). Markii never holds merchant funds and never marks up processor fees.
- **Today:** no auth, single-tenant, agent-only checkout. Phase A adds organizations/staff/roles and re-scopes every route; Phase C adds human cart and checkout. Both are prerequisites for real merchants.

## Capabilities and Constraints

**In scope**

- Marketing landing, full merchant admin, site builder, and storefront surfaces per `docs/PLAN.md` (v3).
- Frontend calls only endpoints defined in `docs/API.md`, and only those marked ✅ LIVE. Never import or query Drizzle / `lib/db` from dashboard code.
- Everything Shopify does except fulfillment logistics — see below.

**Data access**

- Use real `/api/*` only. **No client mocks, no fixtures, no temporary mock route handlers.** Screens handle loading, empty, error, and partial states until endpoints land.
- 🟡 PLANNED areas get a typed service interface in `lib/api/*` and render *configuration required* / *not yet measured* / *coming soon*.

**Product surfaces**

- **Built:** overview, inventory, categories, products, websites (list / create wizard / detail), analytics, finances, integrations. Import with allocate-then-commit; create-site wizard with live HTML / `llms.txt` / `agent.md` / sitemap previews.
- **Planned — platform (v3):** organizations/staff/roles, billing with the threshold fee meter, variants and inventory, collections, customers, cart and human checkout, discounts and gift cards, tax and shipping rate config, order refunds/cancellations/manual fulfillment, the drag-and-drop site builder with custom code, blog/pages/menus/redirects, dispute inbox.
- **Planned — AI layer (v2):** Agent Readiness Score, Catalog Health, Channels, Agent Test Lab, analytics funnel, universal product detail tabs.
- **Planned — add-ons:** Chargeback Assist, then the Agent Ops chat assistant (**built last**).

**Hard boundaries**

- **No fulfillment logistics** — no carrier rates, labels, pick/pack, 3PL, or returns logistics. Manual fulfillment status, tracking entry, and merchant-configured shipping rates for checkout math are in scope.
- **No chargeback guarantees.** Dispute visibility is free, assisted response is an add-on, loss reimbursement is not offered (insurance/underwriting).
- **No custodial funds**, no POS, no B2B price lists, no multi-language storefronts, no app marketplace — all post-launch or never.

**Undecided**

- All price points, thresholds, and fee rates (`docs/PRICING.md` §7) — **blocking**.
- Threshold basis and marginal fee application; trial terms; dunning ladder.
- Auth provider choice; whether v1 demo data is migrated or reset.
- Whether the ops agent may edit page trees directly (recommendation: propose diffs only).

## Brand Commitments

- Product name: **Markii**; bag-bot logo asset in `components/logo.tsx` / `app/icon.svg`.
- Binding visual direction (user-supplied): `/Users/Lonestar/Downloads/visual-design-plan.md` — light neutral UI (`#FAFAFA`), logo gradient reserved for brand mark and key actions, “Vercel / Stripe of AI commerce” posture. Current dark landing tokens are incumbent evidence only under redesign.
- Voice: calm, premium, technical, developer-first / infrastructure — not retail marketplace chrome.

## Evidence on Hand

- `docs/PLAN.md` — v3 platform direction, scope boundaries, phases A–F, open decisions.
- `docs/API.md` — API contract with a per-section LIVE/PLANNED status legend (source of truth for FE↔BE).
- `docs/PRICING.md` — plans, threshold fee engine, GMV definition, billing UX (all values PROPOSED).
- `docs/COMPETITORS.md` — Shopify/Squarespace/Wix/BigCommerce pricing verified 2026-07-29, with source quality tagged and defensible-claim list.
- `docs/BUILDER.md` — agent-native site builder architecture, after [Builder.io's agent-native model](https://www.builder.io/blog/agent-native-architecture). `docs/AGENT-OPS.md` — ops agent add-on.
- `Markii_Frontend_Product_Requirements_Document.pdf` — frontend PRD v1.0 (2026-07-26); its AI-layer requirements survive as Phase E.
- `markii.pdf` — original storefront/catalog surface checklist; still governs what it describes.
- `DESIGN.md` — palette, components, accent rules (light system, reused unchanged).
- Shipped v1: landing page, dashboard, API routes, storefront renderer, x402 checkout.
- No real customer testimonials, benchmarks, production metrics, or verified competitor prices — do not fabricate any of them.

## Product Principles

1. Merchant job first: every screen advances build → sell → get paid → understand.
2. Contract honesty: UI shapes and fields match `docs/API.md`; no invented endpoints, no calls to PLANNED routes, no client-side persistence of secrets beyond the form submit.
3. Truthfulness over completeness: never imply an order, payment, sync, validation, or AI result is live when it isn't. Missing data reads *not yet measured*, never `0`.
4. Cost honesty: the merchant always knows what they pay and to whom. Markii's fee and the processor's fee are shown separately, and a merchant nearing the threshold is warned before it costs them — including when the honest advice is the cheaper plan.
5. Rail neutrality: payment rails are labeled peers; irreversible rails (x402) are labeled as such.
6. Merchant control: AI proposes, the merchant approves. Every automated write is auditable and reversible.
7. Color means something: brand color for action, AI/status, and identity — not decoration.
8. Storefronts stay machine-first and fast; the dashboard is where humans operate.
9. Degrade gracefully: empty, error, and partial states are first-class until APIs exist.

## Accessibility & Inclusion

Baseline web accessibility (keyboard, contrast on the light UI, reduced-motion respect) is the floor; treat WCAG AA as the target.

Two surfaces raise the stakes beyond defaults:

- **The site builder must be fully keyboard-operable.** Every drag-and-drop move, nest, and reorder needs an equivalent path via the layer tree and context menus, with live-region announcements. Mouse-only editing excludes disabled merchants from running their own store (`docs/BUILDER.md` §8).
- **Storefronts inherit whatever merchants build**, so the builder should make accessible output the default: alt-text prompts, heading-order validation, and contrast warnings in the editor, surfaced again as pre-publish checks.
