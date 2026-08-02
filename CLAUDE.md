# CLAUDE.md

Markii is a **commerce platform** — the Shopify/Squarespace category — differentiated by two things:
storefronts that are natively legible to AI agents, and pricing that charges **no Markii transaction
fee** until a merchant crosses an annual sales threshold.

Everything Shopify does **except fulfillment logistics**, plus a drag-and-drop site builder with
custom code, and a chat-driven ops agent sold as an add-on. Multi-tenant storefronts (HTML +
JSON-LD, `llms.txt`, `agent.md`) are one distribution channel; **x402/USDC is one optional payment
rail** alongside card, Stripe, and PayPal — not the product identity.

Started as a 4-hour hackathon (v1, shipped). Now a platform build — read `docs/PLAN.md` (v3) first.

## Commands

```bash
pnpm dev              # dev server (Turbopack)
pnpm build            # production build — run before considering work done
pnpm lint             # eslint + the RLS deny-by-default check
pnpm test             # unit tests — pure money/rule functions, ~1s, no deps
pnpm test:integration # real HTTP + real DB; needs a dev server (see tests/README.md)
pnpm db:push          # push Drizzle schema (dev only — see docs/DECISIONS.md D6)
pnpm db:migrate       # apply generated migrations (needs session-mode DIRECT_URL)
pnpm db:seed          # seed demo data (3 sites, ~30 products, orders, traffic)
pnpm storage:init     # create the two Storage buckets — NOT in the migration chain
```

**Run `pnpm test` freely — it is a second and touches nothing.** `pnpm
test:integration` **writes to the real database** and is opt-in behind a guard;
it takes several minutes. `tests/README.md` explains why the slow suite earns
its keep: every bug found so far lived in the wiring, not the arithmetic.

Package manager is **pnpm** (v11; build-script approvals live in `pnpm-workspace.yaml`).

## Current status

**v1 is complete and real.** DB layer (Postgres + Drizzle, `lib/db/`), every `/api/*` route in
`docs/API.md` §1–8, storefront renderer (`app/%5Fsites/[site]/`), host-routing proxy (`proxy.ts`),
x402 checkout, importer, seed script — plus the v1 dashboard (overview, inventory, categories,
products, websites, analytics, finances, integrations) and the landing page. Requires
`DATABASE_URL` in `.env.local` (see `.env.example`); until then DB-backed endpoints return 500.

**Phases A, C, and the readiness score are built.** Auth, orgs, and tenancy (§16); the action
registry (§22); commerce core (§18.1–18.8) — variants, inventory, collections, customers, cart and
checkout, discounts, tax, shipping, order operations, digital delivery; and rule-based readiness
(§9). Supabase Storage backs both uploads and the files merchants sell.

**Still planned:** the **card rail** (no `STRIPE_SECRET_KEY`; `lib/payments/` reports
*configuration required*), Stripe Tax, gift cards, processor-executed refunds, membership gating,
and all of **Phase B billing** (§17) except the `UsageRecord` meter, which shipped with checkout
because it cannot be derived later. Everything in §10–15 and §19–21 is untouched.

Always check the **status legend at the top of `docs/API.md`** before calling an endpoint — it is
per-section and kept current. Call `/api/*` only — never `lib/db` / Drizzle from frontend screens.

## Launch scope

Team is two people (one frontend, one backend), so launch is a **subset** of the full plan:
**Phase A** (auth/orgs) + **B** (billing, threshold fees) + **C** (commerce core, digital delivery)
+ **3–4 storefront themes** + the **rule-based readiness score**. Roughly 4–6 months.

**Deferred past launch — do not start:** the site builder and action registry (Phase D), Channels,
Agent Test Lab, the analytics funnel (E), Chargeback Assist and Agent Ops chat (F), native email
campaigns. Rationale in `docs/DECISIONS.md` §G10.

## Planning docs

| Doc | Covers |
|---|---|
| **`docs/FRONTEND.md`** | **Frontend start-here** — scope, build order, rules. Read first if you are building screens |
| **`docs/BACKEND.md`** | **Backend start-here** — scope, build order, traps. Read first if you are building `/api/*`, DB, auth, billing |
| `docs/PLAN.md` | v3 direction, scope, launch subset, phases A–F, out-of-scope |
| `docs/DECISIONS.md` | **Decision register** — every settled decision with its reasoning. Check before re-arguing anything |
| `docs/API.md` | Endpoint contracts with LIVE/PLANNED status per section; §22 = action registry |
| `docs/PRICING.md` | Plans, threshold fee engine, GMV definition, billing UX |
| `docs/COMPETITORS.md` | **Verified** competitor pricing with sources and dates |
| `docs/BUILDER.md` | Agent-native site builder: actions, node model, registry, MCP, custom code |
| `docs/AGENT-OPS.md` | Chat ops add-on: safety model, risk tiers (**chat ships last**) |
| `DESIGN.md` · `PRODUCT.md` | Visual system · users, positioning, principles |

## Architecture

- `app/api/` — dashboard REST API (contract: `docs/API.md`)
- `app/(dashboard)/` — merchant admin UI. Today: overview, inventory, categories, products,
  websites, analytics, finances, integrations. Planned: catalog, collections, customers, orders,
  discounts, channels, test-lab, health, automations, **site builder**, settings (team, billing,
  tax, shipping, domains) — with redirects from `inventory` → `catalog` and
  `finances` → `orders/settlements`
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
  heavy bundles, or client state there. Dashboards can be client-rich. Cart, variant picker, and
  checkout are the **only** sanctioned storefront islands, and each must be justified.
- **The site builder must not break agent legibility.** It emits semantic HTML and JSON-LD from a
  versioned node tree — block-based, never a free canvas of nested divs (`docs/BUILDER.md` §1).
- **Agent-native, not agent-compatible.** Every mutating capability is defined **once** via
  `defineAction` and serves the UI, HTTP API, agent tools, and MCP simultaneously. No route handler
  mutates state outside the registry; no agent gets a privileged path around validation or
  permissions. The **registry primitive is built in Phase C** with the first commerce mutations —
  it cannot be retrofitted, so it does not wait for the builder (D) or the chat product (F)
  (`docs/API.md` §22, `docs/BACKEND.md` §1).
- **Money:** integer minor units, explicit currency, no float math. New fields use a `Minor`
  suffix; the older `Cents` fields in `docs/API.md` §1–8 stay as they are. **Formatters derive the
  decimal exponent from the currency** — never hardcode `/100` or two fraction digits, since JPY and
  KRW have none and billing currency is merchant-set (D31).
- **Never hold merchant funds** and never mark up processor fees. Markii's fee is separate, named,
  and visible; Stripe's is Stripe's (`docs/PRICING.md`).
- Validate product input with **zod** before generating HTML or JSON-LD; type JSON-LD with
  `schema-dts`.
- Importers try Shopify `/products.json` → WooCommerce Store API → cheerio sitemap fallback;
  wrap every external fetch in try/catch.
- **Payment rails are neutral.** x402/USDC, card, Stripe, and PayPal are peer options — label the
  rail explicitly wherever a payment appears. x402 is the rail that works end-to-end today; that
  makes it the default demo path, not the product's identity.
- **Never imply something happened when it didn't.** No fabricated metrics, no success toast for
  an unwired action, no test/sandbox data summed into production totals. Unbacked surfaces show
  *configuration required* / *not yet measured* / *coming soon*, and test/demo state is labeled.
- **No mock data or mock route handlers** for PLANNED areas — current direction is real states
  only. New modules get a typed service in `lib/api/*` before any screen calls anything.
- Every data surface covers loading, empty, error, partial, and (once auth lands) permission
  states.
- **Pricing claims are factual claims.** Comparisons come from `docs/COMPETITORS.md` (verified
  2026-07-29, re-check quarterly) — never from memory, and never from an AI assistant's
  recollection. Note what is *not* sayable there: Squarespace already charges 0% store transaction
  fees from $29/mo, so "no transaction fees" alone is parity, not advantage — the real gaps are
  processor lock-in (Shopify/BigCommerce charge up to 2%) and digital goods (Squarespace takes 5%).
- **Auth:** sessions are httpOnly cookies, never `localStorage` — merchant custom code runs on
  storefronts and XSS there must never reach an admin session. **Auth mutations therefore run
  server-side only**: sign-in/up/out/reset go through `/api/auth/*` with Supabase's
  `createServerClient`, never `createBrowserClient` (`docs/DECISIONS.md` D30 — a cookie set from
  `document.cookie` cannot be `HttpOnly`, so browser-side auth fails the rule while appearing to
  satisfy it). Staff and storefront customers **share one Supabase project** (D32) but remain
  separate identity domains. Three requirements are what keep them separate and are binding:
  **never authorize on `auth.getUser()` alone** (membership lookup is the gate), **host-only session
  cookies — never `domain=.markii.shop`** (a parent-domain cookie reaches every storefront, where
  merchant custom code runs), and an explicit **`user_kind`** checked on every path.
- **Merchant-side AI writes go through propose → approve → execute**, with an audit entry and an
  undo path. Retrieved catalog/customer content is untrusted data, never instruction
  (`docs/AGENT-OPS.md` §3).
- Dashboard FE treats upload `url` values as opaque. Storage is now **Supabase Storage** in every
  environment (D6 task 8 done) — the opacity rule is why that swap needed no frontend change.
- **Two storage buckets, and the split is a security boundary.** `public-media` holds product
  images and is public because storefront HTML and JSON-LD reference them directly. `digital-assets`
  is **private** and holds what merchants sell; access is a signed URL minted per paid download, and
  making it public would turn every download limit into decoration. **Never proxy a download through
  a route handler** — it pays egress twice and times out on large files (G5).

## Infrastructure (decided — `docs/DECISIONS.md`)

**Supabase** for database, auth, and file storage (replaces Neon; migrate before Phase A, schema
unchanged). **Stripe Connect Standard** — merchants keep their own account; Markii never takes an
`application_fee_amount`. **FSL-1.1-ALv2** licence: public source, self-hostable, no
resale-as-a-service. Authorization lives in the action registry, **never** Postgres RLS — but
enable RLS deny-by-default anyway, and never expose the service-role key to the browser.

**Email is split by whose mail it is**, and the split is load-bearing — it is what keeps a
merchant's sending reputation from ever touching Markii's own:

- **AWS SES** — everything sent *on merchants' behalf*, from their own domains: order
  confirmations, shipping/refund notices, digital delivery, abandoned cart, shopper account mail.
- **Resend** — *only* Markii's own mail from `markii.shop`: contact form, support, staff auth
  (Supabase Auth SMTP), invoices, dunning, platform notices. **Never merchant mail.**

Call `sendPlatformMail()` / `sendMerchantMail()` in `lib/email/` — pick the stream, never the
provider.

## Brand

Gradient bag-bot logo (`components/logo.tsx`, `app/icon.svg`). **Light theme**
(see `DESIGN.md` / visual design plan): canvas `#FAFAFA`, cards `#FFFFFF`, text
`#16161D`. Logo gradient `#590D22` → `#FF758F`; UI accent `#C9184A` reserved for
logo, primary CTAs, active nav, status, and charts — not decorative chrome.
Use `.text-gradient` / `.bg-gradient-brand` sparingly for brand-only accents.
