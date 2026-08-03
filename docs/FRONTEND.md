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

**Built and working:** the marketing landing page, and a dashboard covering overview, inventory,
categories, products, websites (list / create wizard / detail), analytics, finances, and
integrations — all against **LIVE** endpoints (`docs/API.md` §1–8).

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

## Known gaps in the current shell

The shell shipped 2026-07-30 (screens, themes, design-system additions, typed services for the
planned sections). It is honest — no mock data, no fabricated numbers, every planned surface shows a
real state. These are the open items, recorded so they are not rediscovered later.

| Gap | Where | Fix |
|---|---|---|
| ~~Sign-in runs in the browser~~ ✅ **fixed 2026-07-30** | `components/auth/auth-form.tsx` | Now posts to `/api/auth/*` through `lib/api/auth.ts`, gated on `AUTH_API_LIVE`; `lib/supabase/client.ts` is deleted, so no `createBrowserClient` exists in the tree (**D30**). The form stays disabled behind an API §16 notice until the backend ships the routes |
| ~~Threshold meter hardcodes `/100`~~ ✅ **fixed 2026-07-30** | `components/dashboard/threshold-meter.tsx` | Uses `formatMinor(amountMinor, currency)` from `lib/api/money.ts`, which derives the exponent from the currency (**D31**). `formatCents` stays USD-shaped for the legacy §1–8 `Cents` fields |
| **No cart, variant picker, or checkout** | `components/storefront/` has card, header, theme root, paused | Phase C. The variant picker's shell needs no backend and can start early |
| ~~Every live endpoint gated off~~ ✅ **fixed 2026-08-02** | `lib/api/{readiness,billing,commerce}.ts` | Constants flipped per endpoint group against the routes that actually exist, and the drifted response types corrected. See the two-sided-flip note below |
| ~~§24 email had no client or screen~~ ✅ **fixed 2026-08-02** | `lib/api/email.ts`, `/dashboard/settings/email` | The route and its five actions shipped 2026-08-02 with nothing calling them, while `lib/email/` told merchants to go to a page that did not exist |
| **Screens still stubbed** | Team, invoices, org switcher | Team and the switcher need §16's remaining routes; invoices are Stripe-gated (`configuration_required`, not "coming soon") |
| **Orders list is genuinely blocked** | `/dashboard/orders` | Not a stub to fill: §13 marks list/filter/export **PLANNED** and only `GET /api/orders/:id` exists. Needs a backend route before a screen can be built |
| ~~Collections tab and discounts were stubs~~ ✅ **built 2026-08-03** | `/dashboard/catalog?tab=collections`, `/dashboard/discounts` | Both read-only lists against live routes. Discounts show derived `status`, redemption counts, and a **Fully redeemed** badge — an exhausted code still reads as active by its dates and only fails when a shopper tries it |
| ~~Customers screen was a stub~~ ✅ **built 2026-08-03** | `/dashboard/customers` + `/dashboard/customers/[id]` | List with search, store filter and pagination; detail with memberships, orders and addresses. Money formats from `org.currency` via `formatMinor` (**D31**), never a hardcoded `/100` |
| ~~No memberships screen~~ ✅ **added 2026-08-03** | `/dashboard/memberships` | Tiers with live member counts, create/delete, and manual grant/revoke by customer search (§18.9). Deleting a tier warns that it **ungates** its products, because `requires_tier_id` is `on delete set null` and nothing errors when paid content becomes public |
| **Session refresh is unwired** | `lib/supabase/middleware.ts` is imported nowhere | Backend owns this — it belongs in `proxy.ts`. Nothing guards `/dashboard` until it lands |

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

## Build order

Work top-down. Early items need **no new backend**, which matters because you will otherwise outrun
the backend.

### 1. Storefront themes — start here
No API dependency at all. Three or four themes on the existing renderer in `app/%5Fsites/[site]/`.
This is the launch-critical work least likely to be blocked, and for the target merchant (creators
selling digital products) a good-looking store matters more than any dashboard screen.

⚠️ Storefront rules are strict — see below.

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

### 5. Billing (Phase B)
Start with the **threshold meter** — it is the most important component in the product and the one
most easily made dishonest. Read `docs/PRICING.md` §6 before writing it. Contract: §17.

### 6. Commerce (Phase C)
Variants first (option-matrix editor is the hardest single screen), then inventory, collections,
customers, orders, discounts, settings. Contract: §18. Then storefront cart + checkout.

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

Endpoints land roughly in phase order (A → B → C). Expect to be ahead: the build order above puts
API-independent work first for exactly that reason. When blocked, pick up theme or design-system
work rather than mocking a response.

---

## Definition of done

- All five states implemented (loading, empty, error, partial, permission)
- Calls a typed service in `lib/api/*`, never inline `fetch`, never `lib/db`
- Only LIVE endpoints called; PLANNED areas show honest placeholder states
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
