# CLAUDE.md

Markii is a **commerce platform** — the Shopify/Squarespace category — differentiated by two things:
storefronts that are natively legible to AI agents, and **no platform penalty for bringing your own
payment provider** — ever, on any plan, where Shopify and BigCommerce charge up to 2%. Markii's own
fee starts only above an annual sales threshold, and **physical and digital goods are metered
separately against separate thresholds at different rates** (D39 — `docs/PRICING.md` §3).

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

**The card rail is built.** Stripe Connect Standard, end to end: OAuth connect, **direct charges on
the merchant's own account** (`lib/payments/stripe-charges.ts`), server-side verification at
`/complete`, and **processor-executed refunds** out of the merchant's own balance
(`lib/payments/stripe-refunds.ts`). Markii takes **no `application_fee_amount`** and no
`refund_application_fee` — it is never in the funds flow (D4). `orders.paymentReference` is the
rail-neutral link back to the charge; `txHash` stays x402-only.

**Phase B subscription billing is built; threshold-fee invoicing is not.** The threshold fee engine,
meter, plan catalog, entitlements, and period-close assessments are live (`lib/billing/`), as is the
**Stripe webhook receiver** (`/api/webhooks/stripe` — signature-verified, idempotent on Stripe's
event id, separate secrets for platform and Connect events). **Markii now charges merchants for
plans**: subscriptions, plan changes with a Stripe-computed proration preview, cancellation at
period end, payment methods, and invoice history — all on **Markii's own platform account**, never
with a `Stripe-Account` header (that is the other direction of money, D4). Mutations are actions
(`lib/actions/definitions/billing.ts`); the §17 REST routes delegate to them.

Three invariants hold it together: **entitlements move only when Stripe says a subscription is
paid** (`statusGrantsPlan` grants on `active`/`trialing`/`past_due`, refuses `incomplete`); **a price
is refused when Stripe's amount disagrees with `lib/plans.ts`**, because Markii must not bill what it
does not display; and **the action and the webhook share one derivation** (`lib/billing/mirror.ts`)
so they cannot disagree about what a status grants.

**The threshold fee is billed too, onto the same invoice.** `billing.invoiceAssessments` turns a
closed assessment into a Stripe invoice **item**, which rides onto the merchant's next subscription
invoice as a named line showing its own arithmetic — one relationship, one invoice, one dunning
path. It refuses to bill twice, to raise a zero line, to convert currencies with no FX provider, and
to create an item for an org with no subscription (a pending item with nothing to ride on is never
billed and later attaches to whatever invoice appears). `charging` on the meter is now **per
merchant, not per deployment** — the same rule that kept it false when only a credential existed.

**Nothing here is scheduled.** Period close and fee invoicing run when invoked; there is no job
runner, and a billing step that assumed one would quietly never charge anyone.

**Email plumbing is built; no mail is sent.** `lib/email/` has the SES v2 transport (hand-rolled
SigV4 over `fetch`), per-merchant sending identities, the suppression list, a signature-verified
SNS bounce webhook, and the five transactional templates — wired into `orders.*` and checkout
completion (§24). **Every send is recorded as `not_configured`** because this deployment has no AWS
credentials, and merchant mail is never rerouted through Resend to hide that (G1).

**Membership gating and storefront shopper login are built** (§18.9, D34). Tiers gate products;
buying a granting product confers one inside the order transaction. **Membership status is derived
per request, never stored** — nothing here schedules jobs, so a stored status would keep granting
access after it expired. A refund revokes them, mirroring digital delivery — closing *buy, use,
refund, keep it* for files but not for memberships would only move the hole.

**Recurring memberships are half built, and the built half is the renewal machinery.** A product may
carry `grantsRenewalInterval` (`month`/`year`), which makes the sale a Stripe Subscription **on the
merchant's own Connect account** — shopper pays merchant, no application fee (D4).
**Stripe is the scheduler**, which is what makes recurrence possible at all when nothing here runs
jobs: `invoice.paid` on the *Connect* endpoint extends `endsAt`, so status stays derived and a
cancellation simply stops the extensions rather than revoking anything. It is idempotent on the
invoice id (`lastRenewalInvoiceId`) — Stripe's three-day retry would otherwise grant three periods
for one payment, which `stripe_webhook_events` does **not** protect against, since a genuinely new
invoice must always extend and a redelivery never must. A renewal **meters** as a `usage_record`
with a null `orderId`, classed `digital` (`docs/PRICING.md` §4.1).

**The purchase flow is not built: checkout refuses a recurring product with a `409`** rather than
silently charging once, which would give a shopper one period and never renew while the storefront
said otherwise. A subscription also may not share a cart — it settles through Stripe's invoice, not
the one-off PaymentIntent, so a mixed basket would need two payments for one order.

**§17 is complete.** Add-on *purchase* deliberately refuses with `409` rather than being unbuilt:
Agent Ops and Chargeback Assist are Phase F and do not exist, and selling a $29/mo subscription to
a product nobody can use is the fabricated-success rule with a card behind it. The billing path for
them is already there the day they ship.

**Still planned:** Stripe Tax, recurring membership billing, shopper auth mail via Supabase's Send
Email Hook, and abandoned-cart mail. Everything in §10–15 and §19–21 is untouched.

**Deferred until further notice — do not build, and do not let schema anticipate it:** **gift
cards** (D33, 2026-08-03). The metering exclusion in `docs/PRICING.md` §4.1 is asserted but
unimplemented, so a naive implementation mis-bills merchants in one direction or the other —
`lib/commerce/orders.ts` carries the detail. **This got sharper now that threshold fees are actually
invoiced:** while gift cards do not exist the metering base is not wrong, but the day they ship
without their own tender term, that stops being a wrong *measurement* and becomes a wrong *charge*
on a real invoice. Implement the exclusion in the same change as gift cards, not after.

**What remains is gated by work, not by credentials.** `STRIPE_SECRET_KEY` exists and both the card
rail and subscription billing are written on top of it. Subscription billing needs one piece of
**Stripe-side setup** rather than code: a recurring Price per plan and interval, carrying the lookup
key `markii_{plan}_{month|year}` and the `unit_amount` in `lib/plans.ts`. A missing or mismatched
price refuses by name and says what it should be. AWS SES is the same shape: the code is finished, so
credentials plus sandbox escape plus a merchant's verified domain are all that stand between here and
real mail. Everything refuses rather than stubs — see the `configuration_required` pattern in
`lib/payments/`, `app/api/billing/`, and `lib/email/`.

Two credentials also gate the card rail at *runtime*, and they fail differently:
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is required for Stripe Elements to mount (its absence refuses
the checkout rather than rendering an empty card form), and `STRIPE_CONNECT_WEBHOOK_SECRET` verifies
merchant events — the route **never** falls back to the platform secret.

**The publishable key must be in the same mode as `STRIPE_SECRET_KEY`**, and that is checked, not
assumed (`lib/stripe-mode.ts`, used by both rails). A `pk_live_` against an `sk_test_` succeeds on
every server call and fails only in the browser — after a shopper has typed their card and stock is
already reserved. A mismatch is treated as a missing key, so both rails refuse up front.

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
- **A backend change the frontend can see is not done until the frontend instructions say so.**
  The team is two people working in parallel, so `docs/FRONTEND.md` and `lib/api/*` are how the
  other side learns anything changed. **Going LIVE is a two-sided flip**: when a status badge moves
  in `docs/API.md`, the same change must flip the matching `*_API_LIVE` constant, correct the
  response types in `lib/api/*`, and note the shape change in `docs/FRONTEND.md`. This has already
  failed once — Phases B and C, readiness, the action registry, and email all shipped and moved
  their badges while every constant stayed `false`, so those endpoints were live and reachable from
  no screen. **A stale type is worse than a missing one**: a field pinned to `null` or `never[]`
  makes TypeScript *forbid* reading data the API really returns.
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
- **MFA is mandatory for merchants and never for shoppers** (D40, decided 2026-08-07, **not built**).
  Every staff account enrols at sign-up and is challenged to `aal2` at every sign-in, plus a fresh
  step-up before sensitive changes — the sharpest being the **x402 wallet address, which is the
  money destination** and is today a plain authenticated write. Step-up belongs in the **action
  registry** beside `riskTier`, not in route handlers, or the agent path routes around it (§22
  rule 1). Shoppers are excluded on `user_kind` — guest checkout would make shopper MFA bypassable
  anyway. **Recovery codes are ship-blocking**: Supabase ships TOTP but no backup codes, so without
  our own a lost phone locks a merchant out of everything.
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
