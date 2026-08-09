# Frontend — Start Here

**You own every screen.** The backend (owner) builds `/api/*`, the database, auth, billing, and
payments. This document is the entry point: what exists, what to build, in what order, and the rules
that will otherwise get broken.

## Read in this order

1. **This file** — scope and build order
2. `CLAUDE.md` — working rules (binding)
3. `docs/API.md` — **check the status legend first.** ✅ LIVE = callable today. 🟡 PLANNED = contract
   agreed, route does not exist
4. `DESIGN.md` — tokens, components, patterns
5. `docs/PRICING.md` §6 — only when building billing UI
6. `docs/PLAN.md` / `docs/DECISIONS.md` — background, read when you need the *why*

---

## What already runs

`pnpm install && pnpm dev` → http://localhost:3000. Needs `DATABASE_URL`; without it, DB-backed
endpoints return 500 and screens should show their error state (that is correct behaviour, not a bug
to hide).

**Assume Supabase is in place.** The backend migration from Neon lands before your Phase A work, so
build against it directly — **auth screens post to `/api/auth/*`** (never to Supabase from the
browser — D30, and see the rules below), and Supabase Storage sits behind uploads. You do not need
to sequence around the migration or build a fallback. Uploads need no change from you either way:
the API contract already says treat the `url` as **opaque**, which is exactly why the storage
backend could be swapped without touching a screen.

**Built and working** (2026-08-09): the marketing landing page; auth including the full **MFA** flow
(`/mfa/enroll · challenge · recover`) with step-up handled centrally; and a dashboard covering
overview, catalog, categories, products, collections, customers, orders + settlements, discounts,
memberships, **payments**, websites, analytics, health, and settings (billing, team, tax, shipping,
domains, email). All against **LIVE** endpoints.

**See "What is left" below before picking anything up** — most of what remains is finishing screens
against real response shapes, plus the one genuine gap: storefront themes.

**Existing foundation to reuse, not rebuild:**

```
components/ui/        badge · button · charts · confirm-dialog · date-range-filters
                      empty-state · error-state · field · list-filters · money-text
                      page-header · pagination · status-dot · toggle
components/dashboard/ sidebar · site-card · site-controls · product-form · category-form
                      import-dialog · create-website-wizard · preview-panes
                      transactions-table · integrations-panel · fetch-error
lib/api/              typed client per domain (products, sites, categories, orders, …)
                      + client.ts, server.ts, load.ts, money.ts, types.ts
```

**Add new API calls as a typed service in `lib/api/*`.** Never `fetch()` inline in a component.

---

## Backend status — what you can actually build against today

**The backend is now ahead of the frontend for the entire launch scope.** The build order below was
written when the opposite was true; read this table first, because the sequencing advice ("do
API-independent work so you don't outrun the backend") no longer applies to A, B, or C.

| Area | Contract | State | What it means for you |
|---|---|---|---|
| Auth, orgs, staff, roles | §16 | ✅ LIVE | Build it. Forms post to `/api/auth/*`, identity from `GET /api/me` |
| MFA (merchants) | §16 | ✅ LIVE, screens built | Enrol/challenge/recover ship; step-up retries inline via `MfaStepUpProvider` |
| Payment rails | §8 | ✅ LIVE, screen built | `/dashboard/payments`. Rails split from catalog feeds — different authority, see below |
| Commerce core | §18.1–18.8 | ✅ LIVE | Variants, inventory, collections, customers, cart, checkout, discounts, tax, shipping, order ops, digital delivery |
| Membership gating | §18.9 | ✅ LIVE | Tiers gate products; buying a granting product confers one |
| Readiness | §9 | ✅ LIVE | Score, issues, triage |
| **Billing & metering** | §17 | ✅ **LIVE — newly** | See below. This changed most recently and most sharply |
| Card checkout (Stripe) | §18.4 | ✅ LIVE | Elements mount with a publishable key the server hands you |
| Add-on **purchase** | §17 | ⛔ Refuses `409` | Agent Ops / Chargeback Assist do not exist. Show them as unavailable — never as "coming soon with a buy button" |
| Email delivery | §24 | 🟡 Plumbed, sends nothing | Every send records `not_configured`. Surfaces must say so, not imply mail went out |
| Site builder, Channels, Test Lab, Agent Ops chat | §19–21 | ⛔ Deferred | Out of launch scope — do not start |

### MFA (D40) — built. What to preserve when touching it

Enrol, challenge, and recover ship at `/mfa/*`, and step-up is handled centrally. **The pieces below
are load-bearing; changing any of them silently breaks something that is hard to notice in testing:**

- **`403 MFA_REQUIRED` is handled in `apiFetch`, not per screen.** Step-up opens the modal, verifies,
  and **retries the original request** — which is what lets a merchant change a wallet address
  without losing the form. Handling it in a component instead would send them to a page and discard
  what they typed.
- **Never sign the user out on `MFA_REQUIRED`.** They are authenticated; signing out sends them
  round a loop that cannot fix it. That is why the API answers `403` and not `401`.
- **`/api/auth/mfa` paths are excluded from the interceptor** (`isMfaAuthPath`). Without that, a
  failed challenge would recurse into itself.
- **`_retried` must stay.** It stops a second `403` looping forever.
- **Recovery codes are shown exactly once.** There is no endpoint that can return them again, so a
  screen that lets a merchant continue without saving them has locked them out of their own store on
  the day they lose their phone. Warn on `recoveryCodesRemaining` before it hits zero.

The flow, for reference:

1. **Sign in** — unchanged, `POST /api/auth/sign-in` succeeds as before. MFA is a *second* step.
2. **`GET /api/auth/mfa`** — always reachable, even before MFA is satisfied. That is deliberate: it
   is the only way to find out what to do next. Read `gate.status`:
   - `enroll` → show setup
   - `challenge` → ask for the 6-digit code
   - `ok` → carry on to the dashboard
3. **Enrol**: `POST /api/auth/mfa/enroll` returns `secret`, `uri`, `qrCode` — **shown once, never
   retrievable**. Render the QR from `uri`, and offer `secret` for manual entry (the person whose
   camera does not work is exactly the person who needs a way in). Then
   `PUT /api/auth/mfa/enroll { factorId, code }`.
4. **Recovery codes** come back from that `PUT`, **once**. The screen must make the merchant save
   them — there is no path that can show them again, and they are the only way back from a lost
   phone. A "copy" and a "download" button, and do not let the user dismiss without acknowledging.
5. **Challenge** on later sign-ins: `POST /api/auth/mfa/challenge { code }`.
6. **Recovery**: `POST /api/auth/mfa/recover { code }`. It removes the factor and returns
   `mustEnroll: true` — send them straight to enrolment, **not** the dashboard. Note the session may
   also be invalidated, so handle a `401` here by sending them to sign-in.

**Handling `403 MFA_REQUIRED` globally.** Any authenticated call can return it, including after an
idle period. Treat it in the shared API client, not per screen: read `error.details.gate.status` and
route to enrol or challenge. **Do not treat it as a session failure and sign the user out** — they
are authenticated, and a sign-out loop is the failure mode this status code exists to prevent.

**Step-up is a second, separate prompt.** Money-moving actions — `orders.refund`,
`billing.changePlan`, `billing.invoiceAssessments`, `billing.setDefaultPaymentMethod`,
`email.addSendingDomain`, and `payments.connectRail` / `disconnectRail` — return `403 MFA_REQUIRED`
with
`details.gate.status: "challenge"` when the last factor is older than **15 minutes**, even on a
fully signed-in session. The right UX is a modal asking for the code, then retrying the original
request — not a redirect that loses what the merchant was doing. `details.stepUpWindowMs` says how
long a fresh challenge buys. `GET /api/actions` advertises `requiresStepUp`, so a button can warn
before the click rather than surprising after it.

**Warn before they run out.** `GET /api/auth/mfa` returns `recoveryCodesRemaining`. Someone on their
last code with a broken phone is one bad day from a support ticket nobody can resolve.

**Shoppers never see any of this.** Storefront customers are excluded entirely; `required: false`.

### Payments is its own screen now — and it must not show a balance

Payment rails were split out of Integrations on 2026-08-08. They are different
things and now carry different authority:

| | Payments | Integrations |
|---|---|---|
| What | Stripe, x402 — **where money is paid** | Google Merchant Center — a product feed |
| Endpoint | `GET /api/payments` | `GET /api/integrations` |
| Service | `lib/api/payments.ts` | `lib/api/integrations.ts` |
| Who can change it | owner / administrator (`billing.write`) | `catalog_manager` and up (`catalog.write`) |
| Changing it | **step-up MFA**, expect `403 MFA_REQUIRED` | no second factor |

**Gate the UI on `canAcceptPayments`, not `status`.** Connected is not the same as able to take
money — Stripe enables charges only after verification, and a store told it accepts cards in that
window fails the shopper at the moment they type their card. `requirementsDue` says what Stripe is
still waiting for.

**Two levels to show, or a merchant cannot debug their own store**: whether the *org* has a rail
connected, and whether *this storefront* has it switched on (`stores[].enabled`). A live store
refusing cards is usually the second one.

**`balances` is always `null`, and that is the answer rather than a missing feature.** Render
`balancesNote` and link out to Stripe. Markii never holds merchant funds and uses Connect Standard,
so their own Stripe dashboard is the source of truth for balance, payouts, and processor fees;
restating those here would publish numbers Markii does not own and cannot keep in step. x402 has no
balance at all — it settles on-chain to their wallet, so a combined figure would have to invent one.

**What Markii *is* the source of truth for, and should show:** orders, net sales, and refunds
**across every rail** (Stripe cannot see x402 sales), plus the threshold meter. That lives under
Orders → Settlements and `getBillingUsage()`. The short version: **volume yes, balance no.**

### §17 billing changed shape — screens built against the old refusals need revisiting

Billing used to answer `503 CONFIGURATION_REQUIRED` for everything except reads. It no longer does,
and a screen that treats `503` as the normal case will now render the wrong branch.

What moved:

- `GET /api/billing/subscription` returns a real `subscription` object, or `null` when the org has
  never subscribed. `subscriptionState.code` is now one of `active` · `not_subscribed` ·
  `inactive` · `configuration_required` — the last only when the deployment has no Stripe key.
- **`subscription.entitlesPlan` is the flag to gate on, not `status`.** A subscription can exist and
  grant nothing (`incomplete` = first invoice never paid). Showing a tier because a subscription
  object exists would tell a merchant they are on a plan nobody is charging them for.
- `POST /api/billing/subscription` is **two-step**. Without `confirm: true` it returns a proration
  preview and writes nothing; send `confirm: true` to apply what the merchant just saw. Do not skip
  the preview — the amount is Stripe's arithmetic, and a locally computed estimate will sometimes
  disagree with the real charge.
- `POST /api/billing/payment-method` returns a real SetupIntent `clientSecret` **and** a
  `publishableKey`. Mount Elements with the key the server returns — never one hardcoded or read
  from a different env var, because the server refuses when the two are in different Stripe modes
  and returning that key is how it tells you.
- **Collecting a card is not using it.** After Elements confirms, call
  `billing.setDefaultPaymentMethod` with the returned payment-method id, or the card is attached but
  invoices still fail against nothing.
- `GET /api/billing/invoices` returns `invoices` (Stripe's, real) **and** `assessments` (the
  threshold-fee ledger) under separate keys. **They are not the same thing and must not be merged
  into one list** — an invoice is a demand for payment, an assessment is a measurement.
- `GET /api/billing/invoices/:id` gives line-itemized detail. PDFs are **Stripe-hosted**: link
  `hostedInvoiceUrl` / `invoicePdfUrl`, never proxy or re-render them.
- `GET /api/billing/usage` → `billingStatus.charging` is now **per merchant**. It is `true` only for
  an org whose subscription can carry a fee line. Render the `reason` string; it is written to be
  shown.

### The threshold meter is still the screen most easily made dishonest

`docs/PRICING.md` §6 is required reading before you write it. The three rules that matter:

- Before a first production sale every figure is `null` with `dataSource: "not_yet_measured"` —
  render *not yet measured*, **never `0`**. A zero is a measurement; there has not been one.
- `projectedPeriodFeeMinor` travels with `projectionBasis`. Never display a projection as an amount
  owed.
- `unconvertedRecordCount` / `unclassifiedRecordCount` mean the number is **known-incomplete**. Say
  so rather than showing a clean total.

---

## Known gaps in the current shell

The shell shipped 2026-07-30 (screens, themes, design-system additions, typed services for the
planned sections). It is honest — no mock data, no fabricated numbers, every planned surface shows a
real state. These are the open items, recorded so they are not rediscovered later.

| Gap | Where | Fix |
|---|---|---|
| ~~Sign-in runs in the browser~~ ✅ **fixed 2026-07-30** | `components/auth/auth-form.tsx` | Now posts to `/api/auth/*` through `lib/api/auth.ts`, gated on `AUTH_API_LIVE`; `lib/supabase/client.ts` is deleted, so no `createBrowserClient` exists in the tree (**D30**). The form stays disabled behind an API §16 notice until the backend ships the routes |
| ~~Threshold meter hardcodes `/100`~~ ✅ **fixed 2026-07-30** | `components/dashboard/threshold-meter.tsx` | Uses `formatMinor(amountMinor, currency)` from `lib/api/money.ts`, which derives the exponent from the currency (**D31**). `formatCents` stays USD-shaped for the legacy §1–8 `Cents` fields |
| ~~No cart, variant picker, or checkout~~ ✅ **built** | `components/storefront/add-to-cart.tsx`, `cart-checkout.tsx` | The three sanctioned islands exist. Recurring-membership purchase is the remaining storefront flow |
| ~~Every live endpoint gated off~~ ✅ **fixed 2026-08-02** | `lib/api/{readiness,billing,commerce}.ts` | Constants flipped per endpoint group against the routes that actually exist, and the drifted response types corrected. See the two-sided-flip note below |
| ~~§24 email had no client or screen~~ ✅ **fixed 2026-08-02** | `lib/api/email.ts`, `/dashboard/settings/email` | The route and its five actions shipped 2026-08-02 with nothing calling them, while `lib/email/` told merchants to go to a page that did not exist |
| ~~Invoices screen stubbed on `configuration_required`~~ ⚠️ **unblocked 2026-08-07** | `/dashboard/settings/billing` | §17 is LIVE in full. `lib/api/billing.ts` was corrected in the same change — it had `subscription: null` and `invoices: never[]` pinned from the refusing era, which made TypeScript *forbid* reading data the API now returns. Real types, plus `getInvoice`, `cancelSubscription`, `setDefaultPaymentMethod`, and `getAddon`, are there now |
| ~~Org switcher was a placeholder~~ ✅ **built 2026-08-03** | `components/dashboard/sidebar.tsx` | The sidebar card said "org switching is coming soon with Phase A auth" long after `POST /api/org/switch` shipped. Now a real switcher, shown only when the user belongs to more than one org. Identity is resolved **once in the layout** and passed to both shells, so the rail and the mobile drawer cannot disagree about which org is active |
| ~~Team settings was a stub~~ ✅ **built 2026-08-03** | `/dashboard/settings/team` | Staff with inline role changes, invites against the plan's seat limit, and scoped API tokens. Only **audit and sessions** were missing from §16, not staff/invite/tokens — this table previously said otherwise |
| ~~Orders list is genuinely blocked~~ ✅ **unblocked** | `/dashboard/orders` | `GET /api/orders` ships; the screen exists. Settlements live at `/dashboard/orders/settlements` |
| ~~Collections tab and discounts were stubs~~ ✅ **built 2026-08-03** | `/dashboard/catalog?tab=collections`, `/dashboard/discounts` | Both read-only lists against live routes. Discounts show derived `status`, redemption counts, and a **Fully redeemed** badge — an exhausted code still reads as active by its dates and only fails when a shopper tries it |
| ~~Customers screen was a stub~~ ✅ **built 2026-08-03** | `/dashboard/customers` + `/dashboard/customers/[id]` | List with search, store filter and pagination; detail with memberships, orders and addresses. Money formats from `org.currency` via `formatMinor` (**D31**), never a hardcoded `/100` |
| ~~No memberships screen~~ ✅ **added 2026-08-03** | `/dashboard/memberships` | Tiers with live member counts, create/delete, and manual grant/revoke by customer search (§18.9). Deleting a tier warns that it **ungates** its products, because `requires_tier_id` is `on delete set null` and nothing errors when paid content becomes public |
| ~~Session refresh is unwired~~ ✅ **fixed** | `proxy.ts` imports `updateSupabaseSession` | `/dashboard` is guarded. Note the API surface was never exposed regardless — every data route funnels through `getSession()`, which also enforces MFA |

**Going LIVE is a two-sided flip.** Each planned service gates on a local constant —
`AUTH_API_LIVE`, `ORG_API_LIVE`, `BILLING_API_LIVE`, `READINESS_API_LIVE`, and the commerce
equivalents — so a screen throws `PlannedError` and renders its placeholder instead of calling a
route that does not exist.
When the backend moves a status badge in `docs/API.md`, **the matching constant flips in the same
change**, or the endpoint ships to nobody.

> **This drifted, and it is worth knowing how it failed** (fixed 2026-08-02). Phases B and C,
> readiness, the action registry, and email all shipped and moved their badges, but no constant
> flipped — so every one of those endpoints was live and unreachable from any screen. Two lessons
> are baked into the fix:
>
> - **A section-wide boolean is the wrong granularity for a partial section.** `COMMERCE_API_LIVE`
>   could not be right in either position: `false` hid collections, customers, discounts, and
>   variants, which all work, while `true` would have pointed screens at `/api/variants/:id` and
>   `/api/storefront/cart`, which **have never existed**. Flags are now per endpoint group, as
>   `org.ts` already did.
> - **Flipping a flag is not enough on its own — the types have to be re-read off the route.** Every
>   service that had sat at `false` had drifted: list endpoints return `{ items, total, page, limit }`
>   but were typed `{ items }`; `/api/billing/invoices` returns `assessments`, not `invoices`;
>   the variants route returns `{ productId, options, variants }`, not an array. Flipping without
>   checking would have traded "ships to nobody" for "ships broken".
>
> **`configuration_required` is a third state, not an error.** `isConfigurationRequired()` in
> `lib/api/planned.ts` distinguishes a route that exists but has no credential (Stripe, SES) from
> one that is not built. Those refusing routes are *not* gated to `false` — the contract is agreed
> and the route answers truthfully, so a "coming soon" would be the less accurate of the two.

**Server components must call `lib/api/server.ts`, never the fetch client.** This is now an auth
requirement, not just an optimisation. `requireAuthContext` resolves the caller from `cookies()` —
the **ambient request context**, not the `Request` it is handed. An in-process handler call inherits
that context; a server component that `fetch`es its own API opens a *new* request with no cookie
header, authenticates as nobody, and gets a `401`.

The failure is nasty because it is invisible until the flag flips: while a service is gated `false`
it throws `PlannedError` and the screen shows a placeholder, so nothing ever reaches the fetch. Flip
it to `true` and the same screen starts reporting "could not be loaded" on a perfectly healthy
deployment. Add the endpoint to `lib/api/server.ts` in the same change as the flip. **Client**
components are unaffected — the browser attaches the cookie itself.

`GET /api/me`'s response shape is now pinned in §16 to what `lib/api/org.ts` already assumes, so
that one is settled rather than assumed.

**Themes are done end-to-end** — four defined in `lib/storefront/themes.ts`, wired through the
create wizard, site controls, `PATCH /api/sites`, and the generators. They depend on the
`sites.themeId` column, so if every websites screen 500s against a database provisioned before
2026-07-30, that migration is the reason (`docs/BACKEND.md` §0), not your code.

---

## Your scope for launch

The team is two people, so launch is a deliberate subset of the full plan
(`docs/DECISIONS.md` §G10). **In scope:**

| Area | Screens |
|---|---|
| **Auth & org** (Phase A) | Sign-up, sign-in, reset, org switcher, staff list, invites, role management, settings shell |
| **Billing** (Phase B) | Plan & subscription, invoices, payment method, **threshold meter**, upgrade flow, dunning banners |
| **Commerce** (Phase C) | Products **with variants**, inventory, collections, customers, orders + timeline + refunds, discounts, tax & shipping settings, digital delivery |
| **Storefront** | Cart, variant picker, checkout — plus **3–4 polished themes** |
| **Readiness** | Score card, issues list, issue drawer |

**Deferred past launch — do not start these:** the site builder, Channels, Agent Test Lab, the full
analytics funnel, Agent Ops chat, native email campaigns.

---

## What is left — read this first (2026-08-09)

**Every backend contract in the launch scope is LIVE.** Nothing below is blocked on an endpoint;
if something refuses, it is a *deliberate* refusal that is documented, not unfinished work.

### 1. Storefront themes — the one genuinely launch-critical gap

**What exists:** four theme ids (`studio`, `atlas`, `noir`, `bloom`) wired end to end — stored on
`sites.themeId`, resolved by `getTheme`, applied through `theme-root.tsx`, and emitted into
generated pages. The plumbing is done and works.

**What does not:** `ThemeTokens` is **colours, fonts, radius, and spacing only**
(`lib/storefront/themes.ts`). All four render the *same layout*. That is one theme with four
palettes, not the "3–4 polished themes" the launch scope means — a merchant switching from `studio`
to `noir` gets different colours and an identical store.

This matters more than any dashboard screen: the target merchant is a creator selling digital
products, and a good-looking store is what they are buying. Deciding how far a theme may vary
structure — and doing it without breaking the storefront rules below — is the work.

⚠️ Storefront rules are strict and non-negotiable: server-rendered minimal HTML, no `"use client"`,
no heavy bundles. Cart, variant picker, and checkout are the **only** sanctioned islands. A theme
that reaches for client state has broken agent legibility, which is the product.

### 2. Screens to finish or verify against live data

These have backends and, in most cases, a shell. Each needs the five states and a pass against real
responses rather than the shapes they were first written to:

- **Billing** — the §17 shape changed under these screens. Proration is **two calls** (preview, then
  `confirm: true`), card collection must follow with `setDefaultPaymentMethod`, and invoices and
  assessments are **different lists**. Details below.
- **Orders → Settlements** — `/dashboard/finances` permanently redirects here. This is where
  cross-rail money lives: orders, net sales, refunds. **Not balances** — see Payments.
- **Memberships** — recurring memberships now exist. A membership can be `active` and not renew;
  `status` and `renews` answer different questions and both need rendering.
- **Readiness** — score card, issues list, issue drawer.

### 3. Storefront shopper surfaces

- **Recurring membership purchase** — `POST /_sites/{slug}/api/checkout/subscription`. Requires a
  signed-in shopper, cannot share a cart, quantity is capped at 1. The one-off route returns `409`
  with `useEndpoint` pointing here.
- **Shopper account area** — `GET /_sites/{slug}/api/account/memberships` and the cancel-renewal
  route. A member who cannot stop their own renewal is a support ticket per cancellation.

### 4. Not to be built

Add-on **purchase** (`409`, the products do not exist), the site builder, Channels, Test Lab, Agent
Ops chat, native email campaigns. Email surfaces must say mail is not configured rather than imply
it was sent.

---

## Build order

Work top-down. **The original reason for this order has expired**: it front-loaded API-independent
work so you would not outrun the backend, and A, B, and C are now all LIVE (see the status table
above). Nothing here is blocked on a contract any more.

The order still holds for a different reason — themes and the design system are what everything
after them leans on, and themes are the launch-critical work for the target merchant. But if you
would rather take billing or commerce first, nothing stops you.

### 1. Storefront themes — start here, and they are **half done**
No API dependency at all, and the plumbing already works: four ids wired through `sites.themeId` →
`getTheme` → `theme-root.tsx` → generated pages.

**What is missing is the part that makes them themes.** `ThemeTokens` carries only colours, fonts,
radius, and spacing, so all four render an identical layout — four palettes over one design. For the
target merchant (creators selling digital products) a good-looking store matters more than any
dashboard screen, and "same store, different accent colour" does not clear that bar.

⚠️ Storefront rules are strict — see below. Whatever structure a theme is allowed to vary must stay
inside server-rendered HTML with no new client islands.

### 2. Design-system consolidation
Audit `components/ui/`, fill gaps against `DESIGN.md` (drawer, tabs, stepper, timeline, diff card),
and document usage. Everything after this leans on it.

### 3. Navigation & IA restructure
Rename and redirect, per `docs/PLAN.md` §3: `inventory` → `catalog` (tabs: Products · Categories ·
Collections), `finances` → `orders/settlements`. Add nav entries for the launch scope. Keep
permanent redirects from old paths.

### 4. Auth & org screens (Phase A)
**Forms post to `/api/auth/*`** — Markii's own routes, listed in `docs/API.md` §16. No Supabase call
from a component, no `createBrowserClient`, no client-side session read; identity comes from
`GET /api/me`. Then org switcher, staff, invites, roles. Contract: §16.

### 5. Billing (Phase B) — fully backed, and the shape changed
Start with the **threshold meter** — it is the most important component in the product and the one
most easily made dishonest. Read `docs/PRICING.md` §6 before writing it. Contract: §17.

Then, in the order a merchant meets them: plan comparison → **proration preview → confirm** (two
calls, never one) → card collection via Elements → `setDefaultPaymentMethod` → invoice history →
invoice detail. Dunning banners key off `subscriptionState.code === "inactive"` and the `past_due`
status, which **still grants access** — do not lock a merchant out of their dashboard over a card
Stripe is still retrying.

Two screens that need care rather than effort:

- **Add-ons.** `GET` is real and tells you whether a tier includes one (`includedInPlan`) versus
  whether it was bought (`purchased`). Buying refuses with `409` because the products do not exist.
  Render them as unavailable with the reason — **not** as a purchasable upsell, and not as "coming
  soon" beside a working buy button.
- **Cancellation.** Ends at period end, never immediately. The consequence summary must say what
  the merchant keeps and until when (`currentPeriodEnd`), because that is exactly what the backend
  guarantees.

### 6. Commerce (Phase C)
Variants first (option-matrix editor is the hardest single screen), then inventory, collections,
customers, orders, discounts, settings. Contract: §18. Then storefront cart + checkout.

**Memberships (§18.9) are LIVE and have one rule worth knowing:** status is **derived per request,
never stored**, so there is no `status` field to read and no cached value to refresh — a membership
is active because `endsAt` has not passed. Render from what the API returns each time.

**Recurring memberships are partly built, and the storefront half is the missing half.** A product
can now be marked `grantsRenewalInterval: "month" | "year"`, and the renewal machinery behind it
works — Stripe bills it on the merchant's own account and each payment extends the membership. But
**checkout refuses a recurring product with a `409`** naming the product, because the subscription
purchase flow is not wired yet.

What that means for you:

- **Do not build storefront purchase for a recurring product yet.** It will refuse. The `409`
  details carry `productId` and `interval`, so a cart can render the reason honestly if a merchant
  marks a product recurring before the flow lands.
- **A subscription cannot share a cart**, and that is permanent, not temporary: it settles through
  Stripe's own invoice rather than the one-off PaymentIntent, so a mixed basket would need two
  payments for one order. The cart UI should keep them separate rather than letting a shopper build
  a basket that cannot check out. Quantity is capped at 1 for the same reason.
- **Dashboard product editing can expose the interval now** — the field and its constraints exist
  (a renewal interval requires a granting tier, enforced in the database).
- **A shopper account area now exists and is buildable**:
  `GET /_sites/{slug}/api/account/memberships` lists what they hold, and
  `DELETE /_sites/{slug}/api/account/memberships/{id}/renewal` stops a renewal.
  Two fields are worth rendering apart: **`status`** answers *do I have access?* and **`renews`**
  answers *will I be charged?* They differ all the time — a cancelled membership stays `active`
  until `accessEndsAt`. Showing only the first surprises someone on the day their card is charged,
  or on the day it is not. Use `cancellable` to decide whether to show the button at all; a one-off
  purchase has no renewal to stop and the route refuses.

### 7. Readiness UI
Score card on overview, issues table, issue drawer. Contract: §9.

---

## Rules that will otherwise get broken

**Never call a 🟡 PLANNED endpoint.** Check `docs/API.md`'s status legend every time. Define the
typed service in `lib/api/*` and render *configuration required* / *not yet measured* / *coming
soon* until the route exists.

**No mock data. No mock route handlers. No placeholder numbers.** If there is no backend, the screen
shows a real empty or error state. This is a hard project rule — a fake number that looks real is
worse than a blank screen, and it hides how much is actually built.

**Never imply something happened when it didn't.** No success toast for an unwired action. No
test/demo data summed into production totals. Missing data renders "not yet measured", never `0`.

**Storefront pages (`app/%5Fsites/**`) are server-rendered minimal HTML.** No `"use client"`, no
heavy bundles, no client state. **Cart, variant picker, and checkout are the only sanctioned
islands** — each must be justified. These pages are read by AI shopping agents; semantic HTML and
JSON-LD are the product, and a client-rendered storefront would break the thing that differentiates
Markii. Dashboards can be as client-rich as you like.

**Money:** integer minor units, explicit currency, no float maths. Use `lib/api/money.ts` and
`components/ui/money-text.tsx`. New fields use a `Minor` suffix; older `Cents` fields in §1–8 stay.

**Never call Supabase Auth from the browser.** Sessions are httpOnly cookies, never `localStorage`,
because merchant custom code runs on storefronts and XSS there must not reach an admin session — and
`createBrowserClient` cannot deliver that, whatever package it ships in. Cookies written by
`document.cookie` **cannot be `HttpOnly`**, so a browser-side `signInWithPassword` looks compliant
and isn't. Post to `/api/auth/*` and let the server set the cookie (D30). The same rule covers
storefront customer accounts in Phase C.

**Money formatting derives its exponent from the currency.** Never hardcode `/100` or
`minimumFractionDigits: 2` — `Organization.currency` is merchant-set, and JPY/KRW have no minor
digits, so a fixed divisor renders them 100× wrong (D31). `formatCents` in `lib/api/money.ts` is
USD-shaped by design and stays that way for the legacy §1–8 `Cents` fields; everything with a
`Minor` suffix needs the currency-aware formatter.

**Every data surface covers loading, empty, error, partial, and permission states.** Not optional —
this is the definition of done.

**Accessibility is a launch requirement**, not a follow-up: semantic headings, labelled controls,
keyboard operation, visible focus, and status never signalled by colour alone.

---

## Working with the backend

`docs/API.md` is the contract, and it is **agreed before either side builds**. If a screen needs a
shape the contract does not have, raise it and update the doc first — do not invent a response and
build against it.

**Always check the per-section status legend at the top of `docs/API.md` before calling anything.**
It is kept current, and it is the difference between an endpoint that works and one that returns a
documented refusal.

**You are no longer ahead of the backend — the reverse.** A, B, and C are LIVE. When something is
blocked it is now far more likely to be a *deliberate* refusal (an unbuilt product, a missing
credential) than unfinished work, and those refusals are documented rather than accidental. Render
the refusal honestly; do not mock past it.

**Two practical frictions while both of us are working:**

- **`docs/API.md` is the file we will both edit.** Pull before touching it.
- **Response shapes can move under a screen** when a `503` becomes real, as §17 just did. If a
  screen was built against a refusal, re-check it against the contract rather than assuming it still
  matches.

Backend files (`app/api/`, `lib/db/`, `lib/billing/`, `lib/commerce/`, `lib/actions/`, `drizzle/`)
and frontend files (`app/(dashboard)/`, `components/`, `lib/api/`) are otherwise disjoint, so the
two streams do not collide in practice.

---

## Definition of done

- All five states implemented (loading, empty, error, partial, permission)
- Calls a typed service in `lib/api/*`, never inline `fetch`, never `lib/db`
- Only LIVE endpoints called; PLANNED areas show honest placeholder states
- **A documented refusal is rendered as itself.** `503 CONFIGURATION_REQUIRED`, `409` on an unbuilt
  add-on, and `charging: false` on the meter each carry a reason string written to be shown. Showing
  a generic "something went wrong" throws away the one useful thing in the response — and showing a
  success state instead is the fabricated-success rule in `CLAUDE.md`
- **Money gated on entitlements, never on plan name or subscription existence** — `entitlesPlan` and
  the `entitlements` object are the flags; plans change and capabilities are stable
- Keyboard operable, labelled, visible focus, contrast-compliant
- Money formatted from integer minor units with explicit currency
- Responsive: desktop-first for dashboards, mobile-first for storefronts
- `pnpm build` and `pnpm lint` both pass

---

## Quick reference

```bash
pnpm dev     # http://localhost:3000
pnpm build   # must pass before calling anything done
pnpm lint
pnpm db:seed # demo data so lists render non-empty
```

| Route | What |
|---|---|
| `/` | Marketing landing |
| `/dashboard/*` | Merchant admin — your main surface |
| `/_sites/{slug}/…` | Storefronts in dev (folder is `%5Fsites` — see `CLAUDE.md`) |

**Brand:** light theme, canvas `#FAFAFA`, cards `#FFFFFF`, text `#16161D`, accent `#C9184A` —
reserved for primary actions, active nav, status, and charts. Not decorative chrome. Full tokens in
`DESIGN.md`.
