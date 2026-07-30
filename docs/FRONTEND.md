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
build against it directly — **Supabase Auth (SSR/cookie integration) for all auth screens**, and
Supabase Storage behind uploads. You do not need to sequence around the migration or build a
fallback. Uploads need no change from you either way: the API contract already says treat the
`url` as **opaque**, which is exactly why the storage backend could be swapped without touching a
screen.

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
Supabase Auth with the **SSR/cookie integration** — not the browser client (see rules). Org
switcher, staff, invites, roles. Contract: `docs/API.md` §16. Supabase is already migrated by this
point, so build against it directly.

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

**Sessions are httpOnly cookies, never `localStorage`.** Merchant custom code runs on storefronts,
and XSS there must never reach an admin session. Use Supabase's SSR integration.

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
