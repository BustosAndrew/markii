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
memberships, **payments**, **billing**, websites, analytics, health, and settings (account, team,
audit, tax, shipping, domains, email). All against **LIVE** endpoints.

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
| Org audit log | §16 | ✅ LIVE, screen built | `/dashboard/settings/audit` via `listOrgAudit(filters)`. Owner/administrator only — the tab is gated on role so a `viewer` is not sent to a 403 |
| Account sessions | §16 | ✅ LIVE, screen built | `/dashboard/settings/account` via `listSessions()` / `revokeSession(id)`. The caller's own devices, every role. `wasCurrent: true` means sign the user out |
| Username / org name | §16 | ✅ LIVE, screen built | Sign-up collects `name`. Change it on Account via `updateName()`. Org/company name is `updateOrg({ name })`, owner/administrator only |
| Payment rails | §8 | ✅ LIVE, screen built | `/dashboard/payments`. Rails split from catalog feeds — different authority, see below |
| Commerce core | §18.1–18.8 | ✅ LIVE | Variants, inventory, collections, customers, cart, checkout, discounts, tax, shipping, order ops, digital delivery |
| Membership gating | §18.9 | ✅ LIVE | Tiers gate products; buying a granting product confers one |
| Readiness | §9 | ✅ LIVE | Score, issues, triage |
| **Billing & metering** | §17 | ✅ **LIVE — newly** | See below. This changed most recently and most sharply |
| Card checkout (Stripe) | §18.4 | ✅ LIVE | Elements mount with a publishable key the server hands you |
| **Action undo** | §22 | ✅ **LIVE** | `undoInvocation()` hangs on `/dashboard/settings/audit`. Gate on `outcome.undoable` |
| **MCP server** | §22 | ✅ **LIVE (tools, prompts, resources), no extra screen** | Token-only at `/api/mcp`. Settings → Team mints the token. Session cookies are refused. Connecting a client: `docs/MCP.md` |
| Add-on **purchase** | §17 | ⛔ Refuses `409` | Agent Ops / Chargeback Assist do not exist. Show them as unavailable — never as "coming soon with a buy button" |
| Email delivery | §24 | ✅ LIVE, screen built | SES sends; `/dashboard/settings/email`. Unverified domains still send via the storefront fallback (D44) — do not say mail is not going out |
| **Catalog agent** | §27 | ✅ **LIVE, screen built** (beta) | Opened from **Agents** in the dashboard header (`AgentsNavMenu`). Propose-only; the merchant approves. MCP (§22) is a different surface — do not confuse them |
| **Assistant** | §27 | ✅ **LIVE, screen built** (beta, 2026-10-17) | Opened from **Agents** in the dashboard header. Read-only — answers questions, checks setup, routes to pages/agents. Reuses `AgentPanel` with `agent="assistant"` |
| **Setup checklist** | §28 | ✅ **LIVE, screen built** (2026-10-17) | Overview card via `getSetupStatus()`. `firstRun` leads the page; `next` is the headline. No local ticks — refetch by revisiting |
| Site builder | §19 | ✅ **LIVE, screens built** (D51 M1–M7 · D53) | `/dashboard/websites/[slug]/design` — editor, live preview, brand agent, templates/regions/bindings (M4), page SEO + agent documents (M5), custom CSS/HTML/classes and Theme-tab custom scripts (M6); breakpoint switcher, multi-select, copy/paste, saved blocks (M7); **theme copy/export/import and Next.js export** on the Theme tab (D53). Storefront keys: website settings, Exported storefront |
| **Brand agent** | §27 | ✅ **LIVE, screen built** (beta, 2026-11-02) | Lives in the site editor, not a drawer: directory `surface: "editor"`, and the Agents menu navigates to `href`. Edits the draft directly; Stop is `stopBrandAgent` |
| Channels, Test Lab | §10 · §12 · §20 | ⛔ Deferred | Out of launch scope — do not start |
| Platform admin | §26 | ✅ LIVE, screens built | `/admin` when `me.operator`. Suspend/reinstate and **Reset MFA** (`resetPlatformMfa`). Never on merchant nav for anyone else |

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
- **A first subscription is not done at `confirm: true`.** That response carries `clientSecret` and
  `publishableKey`. Mount Payment Element and `confirmPayment` — this is the first invoice, not a
  SetupIntent, and **there is no Stripe Checkout redirect**. Throwing the secret away and reloading
  is how a merchant ends up looking subscribed with no card collected (`incomplete` grants nothing,
  but Starter is also the floor so the copy can still say "Subscription active").
- **An unpaid subscription is a state with two exits, and both must be on screen** (2026-08-20).
  `incomplete` grants nothing, so gating the plan buttons and the cancel button on `entitlesPlan`
  left a merchant unable to pay for the plan they picked *or* to get rid of it — the only other
  route out was to wait 23 hours for Stripe to expire the invoice. So:
  - The pending plan's button is a live **"Resume payment"**, never a disabled "Payment pending".
    `POST /api/billing/subscription` for that same plan reopens the *existing* invoice and returns
    its `clientSecret` with **`resumed: true`** — no second subscription and no second charge, so
    say "resume", not "subscribe again". Picking a *different* plan discards it and starts the new
    one.
  - **Render the cancel control whenever `subscription` is non-null**, not only when
    `entitlesPlan` is true. For an unpaid one, `DELETE` answers **`discarded: true`** with a null
    `endsAt`: it ended immediately because there was no paid period to protect. Branch on it —
    "cancellation scheduled, you keep access until…" is false there and names a date that does not
    exist. Say nothing was charged.
- **A stored subscription id can outlive the subscription**, and the API now repairs that rather
  than erroring: Stripe expires an unpaid first invoice by *updating* it to `incomplete_expired`,
  not deleting it, so the webhook that clears the id never fires. `POST`/`DELETE` resolve the id
  against Stripe, clear the mirror when it is dead or gone, and behave as a first subscription. A
  screen needs no special case for it — but do not assume `subscription != null` means Stripe still
  has one.
- **Every account now has a free month, and it ends hard** (D45, 2026-09-04). `GET /api/me` and
  `GET /api/billing/subscription` both carry `standing`: `subscribed` · `trialing`
  (`endsAt`, `daysLeft`) · `expired` · `ungated`.
  - `TrialBanner` renders from `me.standing` in the dashboard layout, so it is on every page.
    **`ungated` and `subscribed` render nothing** — a permanent band telling a paying merchant
    they are paying is the noise that makes people stop reading the banner that matters.
  - **Every mutating call can now answer `402` with code `TRIAL_ENDED`.** Handle it like a
    payment wall, not an auth error: it is **not** `403`, so it must not reach the MFA step-up
    modal — the permissions are fine and a second factor changes nothing. `apiFetch`
    (`lib/api/client.ts`) already sends a browser mutation there —
    `/dashboard/billing` — and never treats it as MFA. Reads stay on the
    page; do not blank them. `details.endedAt` says when it lapsed.
  - **Reads keep working when expired.** Catalog, orders and customers stay listable and
    exportable by design; do not blank those screens on `expired`.
- Plan, card, cancel, usage, invoices, and assessments live at **`/dashboard/billing`**.
  Changing a plan requires MFA; the screen says so before Confirm. Old
  `/dashboard/settings/subscription` and `/dashboard/settings/billing` URLs redirect here.
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

### 🔴 Four live endpoints had no typed service — found 2026-08-10, services now exist

A sweep reconciling every route against `lib/api/*` found four endpoints that were **built, live, and
reachable from no screen**. This is the failure CLAUDE.md records as having happened once before,
recurring where nobody had looked: `docs/API.md` marked them live and the badge was telling the truth
about the *backend*. The services unblocked the screens; **digital delivery, discount preview, tax
preview, and inventory levels all have screens now** (`/dashboard/delivery`, `/dashboard/discounts`,
`/dashboard/settings/tax`, `/dashboard/catalog` / inventory).

**1. Digital delivery (§18.8) — the serious one, and it is launch scope.** `lib/api/delivery.ts` is
the client. Screens shipped 2026-08-17 at `/dashboard/delivery` and on the product editor. D5 names
creators and digital-goods sellers as the **beachhead segment**.

- `uploadDigitalAsset(file, { siteId, label })` — `FormData`, **not** an action. Bytes do not belong
  in an audit row. Deliberately no client-side type allowlist: a merchant may sell any file type.
- `listDigitalAssets()` — carries advisory `usage`. **There is no `url` field and that is not an
  oversight** — the bucket is private, and a durable address for a paid file is one leak away from
  being the product. Never render or construct one.
- `attachAsset` · `detachAsset` · `deleteAsset` · `setDownloadPolicy` · `reissueDownload` ·
  `revokeDownload` — all actions. **Detach ≠ delete**: detach removes the attachment, delete removes
  the file that buyers already hold grants against. Worth different confirmation copy.
- On `setDownloadPolicy`, `null` means **unlimited**, not unset. Render it as unlimited or a merchant
  reads a blank box as something they still need to fill in.

**2–4. Three merchant-facing previews**, each of which writes nothing and charges nothing:

| Service | Endpoint | Belongs on |
|---|---|---|
| `previewDiscounts()` (`commerce.ts`) | `POST /api/discounts/validate` | `/dashboard/discounts` |
| `previewTax()` (`tax-shipping.ts`) | `POST /api/tax/calculate` | `/dashboard/settings/tax` |
| `listInventoryLevels()` (`commerce.ts`) | `GET /api/inventory/levels` | `/dashboard/inventory` |

`previewDiscounts` redeems nothing and consumes no usage allowance, so testing a single-use code does
not burn it. `previewTax` is never the source of a number anyone is billed — checkout recalculates
from the cart. `listInventoryLevels` answers "what is low across the catalog", which per-product
reads cannot assemble without fetching everything.

**Stripe Tax went LIVE 2026-08-17 (`docs/API.md` §18.6), and it changes three things on
`/dashboard/settings/tax`.** ✅ **screens updated 2026-08-17** — the form keeps `stripe` as a
saved provider (it used to coerce it to `manual` on load, which would overwrite a live Stripe Tax
store), renders the three `stripeTax` facts separately, saves `defaultTaxCode`, and the preview
takes `shippingMinor` / `taxCode` / `currency` behind an explicit button. Variant `taxable` /
`taxCode` are on the product editor; a recurring membership on a `manual` store warns before
checkout's `409`.

1. **`stripe` is a selectable provider now.** The form's disabled option and its "not available yet"
   caption are gone. Nothing else about `updateTaxSettings` changed.
2. **`TaxSettings` gains `stripeTax`** (`StripeTaxFacts | null`, null on any other provider), and it
   carries **three facts that must be rendered separately**: `platform` (Markii's credentials, ours
   to fix), `connected` + `status` + `missing[]` (the merchant's Stripe account — `missing` is
   Stripe's own list of what it still wants, show it verbatim), and `activeRegistrations`. One
   combined tick sends a merchant to fix the wrong thing, which is the same reason the domain status
   surface keeps ownership, pointing, and platform apart.
   **`activeRegistrations: 0` is the state to shout about**: Stripe Tax with no registration
   calculates a real zero everywhere, so the store looks configured, charges nothing, and the
   merchant finds out when they file. `null` means the count could not be read — *not* that there
   are none, so never render `null` as zero. `operational.reason` already says all of this in one
   sentence if you would rather show one line.
3. **`previewTax` on a `stripe` store is a real Stripe call the merchant is billed for.** The screen
   already handles this correctly — `components/dashboard/tax-preview.tsx` fires it from a form
   `onSubmit`, so one click is one call and **no debouncing is needed**. (An earlier revision of this
   note asked for debouncing; that was wrong, checked 2026-08-18.) Keep it that way: if this ever
   moves to an `onChange` or an effect, every keystroke becomes a charge on the merchant's Stripe
   account. It also takes `shippingMinor`, `taxCode`, and `currency` now, and returns `currency`.

**The cart's `tax` component now carries a `breakdown`, and two more stale types were corrected.**

`StorefrontCart["tax"]` is a `TaxComponent` — `MoneyComponent` plus
`breakdown: { name, rateBps, amountMinor }[]` (empty, never absent). Both engines were already
producing it and `priceCart` was throwing it away, so no surface could show a shopper *what* they
were charged. **Render it**: a single "Tax $4.99" line on a Colorado order hides a state rate, a city
rate, and a district rate, several jurisdictions require the itemisation on a receipt, and on a
**tax-inclusive** store `amountMinor` is zero by design — the breakdown is the only place the
figure appears at all. Never read a zero there as "no tax".

`MoneyComponent["state"]` in `lib/api/storefront-cart.ts` was typed `"final" | "provisional" |
"not_applicable"` — **none of which the server has ever returned**. Those are `totalState`'s
values, copied onto the wrong type, so any screen branching on that union matched nothing and fell
through its default for every cart. It is `"calculated" | "none" | "not_configured"`, and
`not_configured` is the one that blocks checkout.

**`Collection["rules"][].field` was wrong in both directions** (corrected 2026-08-18). It offered
`tag`, `vendor`, and `type` — which the server rejects **by name**
(`UNSUPPORTED_RULE_FIELDS`, `lib/commerce/collections.ts`), because the product model has no such
columns — and it **omitted `sku`**, which the server does support. So a rule builder populated
from this type would have offered three options that could only ever fail, while TypeScript forbade
the one extra field that works. It is now `"title" | "price" | "stock" | "sku"`. No screen was
affected: nothing builds a field picker from it yet. Build one from the type, not from memory.

**There is a component test suite now: `pnpm test:components`** (`vitest --project components`,
happy-dom, ~1.5s). It exists because the two worst bugs in the storefront cart were invisible to
every other check — not type errors, and not reachable from an integration test, because the
island renders in a browser. `components/storefront/cart-checkout.test.tsx` is the pattern: mock only
the network, feed payloads **captured from the live API**, assert what the shopper reads.

It is not a mandate to test every component. It covers renders where being wrong misstates money or
blocks a sale. Add to it when you touch one of those; skip it otherwise.

**The storefront cart island was leaking internal state names to shoppers, and that is fixed**
(`components/storefront/cart-checkout.tsx`, 2026-08-17). It rendered `Tax ({cart.tax.state})` and
`Shipping ({cart.shipping.state})` — so a customer saw literally **"Tax (not_configured)"**. Three
things changed, and they are worth knowing if you touch that block:

- The raw enum is gone. `not_configured` now renders an em dash plus the component's own `note`,
  because that state **refuses the sale** — a shopper who is not told why meets a checkout that
  simply will not proceed.
- The **tax breakdown renders**, one indented line per jurisdiction with its rate.
- **Tax-inclusive stores no longer show "Tax £0.00".** `amountMinor` is zero by design there, so
  the label becomes "Tax (included)" and the figure comes from summing the breakdown. It is still
  **not** added to the total — it is already inside the line prices.

New CSS class `.sf-component-note` in `components/storefront/cart-island.css` for those sub-lines.

**Two stale types in `lib/api/tax-shipping.ts` were corrected in the same change**, and one of them
was actively wrong on screen: `TaxPreview["state"]` was typed `"calculated" | "not_configured" |
"address_required"`. The route has never returned `"address_required"` (a missing address is
`not_configured` with the reason in `note`), and it was **missing `"none"`** — the common case, a
store that has told us it collects no tax. A screen branching on that union rendered every
un-taxed store as a misconfiguration. `breakdown[].name` is also `string`, never null.

Nothing changes for storefront checkout screens: `not_configured` still blocks the sale and still
carries its reason, exactly as it did for manual rates.

**Plan prices are FINAL as of 2026-08-10 (D42) — and this one changes a type.** `GET
/api/billing/plans` and `GET /api/billing/subscription` now return `status: "final"` where they
returned `"proposed"`. In `lib/api/billing.ts` the field was pinned to the literal `"proposed"`;
it is now `PriceStatus = "proposed" | "final"`, **widened deliberately rather than swapped to a
`"final"` literal** — pinning it is what made this breaking, and prices can move again. Read the
field; do not assume its value.

What to change on screens: **drop the "prices are not final" caveat** from pricing and billing
surfaces. It was correct and is now false, and a stale caveat undersells a settled price.

**Add-on prices are still `"proposed"`** and `GET /api/billing/addons/:addon` still says so. The
sign-off covered the §3 plan table only — Agent Ops and Chargeback Assist do not exist, so keep
presenting those as unavailable, never as buyable.

**Threshold fees are now billed on a schedule (2026-08-10, `docs/API.md` §25).** Nothing in
`lib/api/*` changes and no screen needs editing — but the copy on billing screens does, because one
thing that used to be true no longer is. Period close and fee invoicing ran only when a human
invoked them; they now run monthly (`0 3 1 * *`) via `GET /api/cron/billing`. **So do not write copy
implying a merchant must do anything to be assessed, and do not describe an assessment as
provisional.** An unbilled assessment is now genuinely pending a scheduled charge rather than
pending someone's attention.

Two knock-on details worth having:

- `GET /api/actions` gains **`billing.closePeriod`** (risk `medium`, **no step-up**). It is operator
  surface — there is no reason to put it behind a merchant-facing button, and the step-up list below
  is unchanged because closing a period charges nothing.
- The cron endpoint itself has **no `lib/api/*` service and no `*_API_LIVE` constant**, deliberately:
  no screen calls it. If a billing-ops screen is ever wanted, ask first — it needs the platform
  secret, not a merchant session.

### 🔴 Custom domains are verified now — and `customDomain` stopped being a writable field (2026-08-14)

**Breaking, and it is a type error, not a surprise at runtime.** `createSite` and `updateSite` take
`SiteWritable` (`lib/api/sites.ts`), which **omits** `customDomain` — sending it is a `400`, refused
by name rather than stripped, exactly like `walletAddress`. Two screens sent it and both are updated:
the create-website wizard now claims the domain after the site exists, and the website detail page
uses the new panel.

It was free text that any `cms.write` role could write straight into the routing table with no proof
of ownership — so one org could claim a hostname belonging to somebody else and answer for it the
moment that host pointed at Markii. Ownership is now a DNS TXT record.

New service `lib/api/domains.ts` (`DOMAINS_API_LIVE = true`) and a new server loader
`getSiteDomain(slug)` in `lib/api/server.ts`:

| Call | What it is |
|---|---|
| `getSiteDomain(slug)` | Status + the records to publish. **Reads DNS live**, so fetch it on the server and pass it down — do not poll it from a client effect |
| `getOrgDomains()` | Every storefront's domain, org-wide. **Reads no DNS** — backs Settings → Domains |
| `connectDomain({ siteId, domain })` | Claims it. `409` only if another storefront **verified** it |
| `verifyDomain({ siteId })` | The "Check DNS" button. Pull, not push — nothing polls for the merchant |
| `disconnectDomain({ siteId })` | High risk. `stoppedServing` tells a live removal from an abandoned claim |

Three rules for any screen that touches this, all of them the same rule:

- **Never render a `pending` domain as the store's address.** It routes nothing. `Site.storefrontUrl`
  already falls back to the Markii subdomain until the domain verifies — trust it rather than
  building the URL from `customDomain` yourself.
- **Ownership and pointing are two facts, never one tick.** `status: "verified"` means Markii will
  route the host; `pointsToMarkii` means the merchant's DNS actually sends traffic here. Only both
  together mean the storefront answers. A merchant who published one record and not the other needs
  to be told *which*.
- **A missing record is the normal first answer, not a failure.** Propagation takes up to an hour.
  `checked: false` is the real error case — DNS was unreachable — and it never downgrades a verified
  domain.
- **Three facts now, not two.** `SiteDomain.platform` is the one that decides whether the storefront
  actually answers: Vercel rejects a hostname not registered to the project at its edge and issues no
  certificate. It is `null` until the domain verifies (correct, not a failure), and `registered:
  null` means **unknown** — the platform was unreachable — which must not render as "not registered".
  `configured: false` is **Markii's** problem, not the merchant's; word it that way, the same
  distinction `customerEmail.code` draws on the email screen.
- **`platformRegistration: "queued"` from `verifyDomain` means attempted, not done.** It runs after
  the transaction commits, so the action cannot know the outcome. Never render it as success —
  re-read `getSiteDomain`.
- **`deploySite` gained `hostAttached` / `hostProblem`.** Publishing now also attaches
  `{slug}.{ROOT_DOMAIN}` to the hosting platform, and it can fail on its own. **`hostAttached: false`
  means published but not reachable** — `storefrontUrl` will fail TLS. Show `hostProblem` (its copy
  already separates Markii's fault from the merchant's) and offer deploy again as the retry, rather
  than linking to an address that breaks.

**`/dashboard/settings/domains` is a real screen now**, not a `ComingSoon`. It is an *overview*, not
a control panel: connecting and verifying stay on the storefront's own page, because the DNS records
are per site and a merchant acting on them needs that site in front of them. The one rule it adds —
**nothing on that page is a live reading.** `getOrgDomains` reads no DNS, so a domain whose DNS broke
an hour ago still shows `verified` there. The page says so in as many words; do not add a "reachable"
tick to it, and do not treat a missing `pointsToMarkii` as `false`.

### 🔴 Action undo is live (2026-08-18) — and the Undo button has one honest shape

`undoInvocation(actionId, invocationId)` is unblocked. Four things decide whether the UI built on it
tells the truth:

**Gate the button on `outcome.undoable`, and trust it.** It used to be a hand-set boolean on the
action definition that nothing read, and it was wrong on four actions. It is now derived from the
action's `inverse()` and `defineAction` refuses a definition where the two disagree — so a `true`
means there is a real way back. Do not render Undo when it is `false`, and do not offer it as a
disabled control with a tooltip promising it later.

**Undo runs the inverse as a new invocation, so it can challenge.** A `403 MFA_REQUIRED` from an
undo is normal — `MfaStepUpProvider` already turns that into the modal. It can also `403` on
permission: undo holds no authority of its own, so a role that has since lost `catalog.write` is
refused.

**`conflict` is a question, never a retry.** All five refusals are `409`, distinguished by
`error.details.undo`. Four of them (`already_undone`, `no_inverse`, `not_representable`,
`failed_invocation`) are terminal — say so plainly and remove the button. `conflict` is the only one
that means "ask the human": `error.details.conflicts` names each field with `expected` and
`current`, because somebody edited the same row since and undoing would discard their change.
Show what would be overwritten. **Never auto-retry it** — the whole point of the refusal is that a
person has not seen the other edit yet.

**Report `undoneWith`, not the id you sent.** Undoing `email.suppressAddress` runs
`email.unsuppressAddress`; undoing a first `domains.connect` runs `domains.disconnect`. A toast
saying "suppress address undone" when the log will show an unsuppress is the kind of small lie that
makes an audit trail untrustworthy.

The audit list carries both directions now — `undoneBy` on the original row, `undoOf` on the undo —
so a history screen can strike through a reversed change and label its reversal without a second
query. Both are `string | null` on `ActionInvocation`.

### 🔴 New 2026-11-19 — per-store scoping is enforced now (D52); store-scoped members see less

`StaffMember.storeIds` / a token's `storeIds` used to narrow a few list routes and nothing else. They
now narrow **every** org-scoped read and write — single-item routes, lists, and every registry action.
No type changed; what changes is what a store-scoped member gets back:

- **Another store's item answers `404`**, exactly as a missing one does — product, order, customer,
  discount, category, page, domain, download. Screens already handle 404; make sure none renders it
  as "deleted" when the member simply cannot reach it.
- **Lists are shorter.** Discounts, customers, collections, shipping zones and rates, inventory
  levels, and the overview, analytics and finances pages used to show every store to a scoped member.
  They now show that member's stores only. Totals are over those stores, so don't label them
  "all stores" for a scoped member (`me.storeIds !== "all"`).
- **`delivery.deleteAsset` answers `403 FORBIDDEN`** for a file with no store (shared by every store)
  unless the caller reaches all stores. Show its message; offer *detach* instead.
- An empty `storeIds: []` reaches nothing, and every store-specific screen will be empty. That is
  correct, not a loading bug.

**Two new 403 codes (same day): role says *what*, `storeIds` says *where*.** Neither is a
permissions problem, so neither should show the step-up modal or "your role cannot…":

- **`STORE_SCOPED`** — a member scoped to some stores tried an org-wide change: any `billing.*`,
  `payments.*`, `integrations.*` or `email.*` action, `PATCH /api/org`, `POST /api/sites`, the add-on
  routes, or uploading a digital asset with no store. Say it needs someone with access to all
  stores. Better: hide those controls when `me.storeIds !== "all"`.
- **`BEYOND_YOUR_ACCESS`** — a grant wider than the caller's own, or managing someone whose reach is
  wider. `details.reason` is `"role"` (e.g. a `developer` minting an `administrator` token) or
  `"stores"`. Applies to token creation and revocation, invitations, and staff edits and removal. The
  token and invite forms should only offer roles and stores the caller holds.
- **`storeIds` is optional on `POST /api/org/tokens` and `/api/org/staff/invite` now**, and an
  omitted value means *the caller's own stores*, not `"all"`. An all-stores caller sees no change.
- `GET /api/digital-assets` lists shared files plus the caller's own stores' files.
- **`GET /api/me` carries `storeIds`** (`"all"` or a number list, same as the staff row) so the
  shell can hide org-wide writes without a second call. `lib/api/org.ts`: `reachesAllStores()`,
  `grantableRoles()`, `storesWithinReach()`.

### 🟢 New 2026-11-22 — storefront forms — needs screens

`lib/api/forms.ts`; contract in `docs/API.md` §19 "Storefront forms". **Migration 0053 — applied
2026-11-22.** Three screens, two permissions: the **form editor** is `cms.write`; **submissions** and
the **blocklist** are customer data — gate them on `commerce.read` / `commerce.write`, not on cms.

- **Forms list + editor** (website area, beside Blog): name, fields (type, label, required, choices for
  `select`, optional placeholder and max length), button label, thank-you message, *Email each
  submission to* (`notifyEmail`, empty = store only). Show the form's address `/forms/{handle}` and say
  it is live at once. **The handle is fixed after creation** — show it read-only on edit.
- **Delete** answers `409 in_use` with `details.pages` while a page shows the form — list those pages.
  Say plainly that submissions are kept.
- **Submissions inbox** (`listFormSubmissions`): newest first, filter by form handle, search. Render
  `values` as label → answer in order (booleans as Yes/No). Show `notify.status` honestly — *Emailed*,
  *Email failed: {error}*, *Not emailed* (`off`). A submission whose `form.exists` is false belongs to a
  deleted form — still show it. **Reply** is a `mailto:` to `email`.
- **Delete a submission** is for erasure requests: confirm, say it cannot be undone. Submissions never
  expire on their own — don't add any "auto-delete" setting.
- **Block sender** from a submission → `blockFormSender({ pattern: email })`, or the domain
  (`@domain`). A blocklist screen lists entries with *Unblock*. Both undoable.
- **Builder:** the `form` block's inspector has a text field for `formHandle`; better, offer a select
  filled from `listForms`. Publishing refuses `UNKNOWN_FORM` / `FORM_NOT_CHOSEN`.
- When the screens ship, add a line to `lib/ops-agents/assistant/help.ts` saying where they are.

### 🟢 New 2026-11-22 — the blog — needs a screen

`lib/api/blog.ts` → `listBlogPosts`, `getBlogPost`, `createBlogPost`, `updateBlogPost`,
`publishBlogPost`, `unpublishBlogPost`, `deleteBlogPost`; contract in `docs/API.md` §19 "Blog".
**Migration 0052 — applied 2026-11-22.** `cms.read` / `cms.write`.

- **Suggested home:** a *Blog* tab in the website area beside *Design* — list (status chips `Draft` /
  `Scheduled` / `Published`, filter with `status`, search with `q`) and a post editor.
- **The editor is a Markdown textarea**, not the block builder. Show the syntax card from the
  `lib/api/blog.ts` header. For a preview, load the builder preview iframe at
  `{previewUrl}/blog/{handle}` (drafts show there, labelled). **Don't** reimplement the parser in the
  browser; it would drift from what shoppers get.
- **Say the publishing model plainly**, because it differs from Design: *"Posts publish on their own.
  Once a post is live, saving changes updates it straight away."*
- **Publish** → `publishBlogPost({ postId })`; a *Schedule…* option sends `at` (ISO, from a date-time
  picker in the merchant's timezone, converted to UTC). `409 checks_failed` → show `error.message`.
  Show `result.warnings` (cover without alt) as a note. *Unpublish* → `unpublishBlogPost`. Both
  undoable (the usual undo toast).
- **Delete** is drafts only and not undoable — hide it on live and scheduled posts (or disable with
  "Unpublish it first"), and confirm before sending.
- **Cover image:** the usual image upload (`url` is opaque) sent as `coverImage`; require alt text in
  the form even though the API only warns.
- **Handle:** prefilled from the title on create; on a live post, show *"Send the old link here"*
  (checked) when it changes → `redirectOldLink`.
- **SEO** is replaced whole — send all four fields, as with builder pages.
- A builder block listing recent posts is **not** built yet; link to `/blog` from a navMenu meanwhile.
- When the screen ships, add a line to `lib/ops-agents/assistant/help.ts` saying where it is.

### 🟢 New 2026-11-21 — storefront redirects — needs a screen

`lib/api/redirects.ts` → `listRedirects`, `createRedirect`, `updateRedirect`, `deleteRedirect`,
`previewRedirectImport`, `importRedirects`; contract in `docs/API.md` §19 "Storefront redirects".
**Migration 0051 — applied to the shared database 2026-11-21.** `cms.read` to see, `cms.write` to change.

- **Suggested home:** website settings, a *Redirects* section — or its own tab beside *Design* if the
  list gets long. A moved store can have thousands: page with `limit`/`offset`, search with `q`.
- **Say what it does, because it is not obvious:** *"Sends an old link to its new place. Only used when
  nothing on your store answers that link — it never hides a live page."* And: *"Takes effect as soon
  as you save — no publish needed."*
- **Form:** *Old link* (a full URL pasted from the old store is fine — show the stored `from` after
  save, it is normalised and lower-cased), *Goes to* (path or https URL), *Permanent* (on by default;
  explain off as "temporary — search engines keep the old link").
- **Errors:** `400` → put `error.message` under the field named by `error.details.field` (`from`/`to`);
  `409` `from_taken` → "There's already a redirect from that link" with a way to edit it; `loop`;
  `limit`.
- **Bulk import (CSV paste or upload, two columns):** parse client-side, ≤ 1,000 rows per call. Call
  `previewRedirectImport` first and show `skipped[]` (`row` is the index you sent, `reason` is a
  sentence) beside the counts; then `importRedirects` with the same body. Offer *Replace existing* →
  `replace: true`. Import is not undoable; single create/update/delete are (the usual undo toast).
- When the screen ships, add a line to `lib/ops-agents/assistant/help.ts` saying where it is.
- **Renames make redirects on their own (2026-11-22):** changing a product's slug or a collection's
  handle, and publishing a page whose handle changed, leaves a redirect from the old address. On the
  product and collection forms, show a checkbox beside the slug/handle field when it changes —
  *"Send the old link here"*, checked — and send `redirectOldLink: false` when unchecked. Those
  redirects appear in the list like any other; nothing else to build.

### 🟢 New 2026-11-21 — compare design versions (§12) — needs a screen

`getDesignDiff(site, { from?, to? })` in `lib/api/builder.ts` → `DesignDiff`; contract in
`docs/API.md` §19 (`GET /api/builder/sites/:idOrSlug/diff`). **No migration, no action** — a read,
`cms.read`. Each side is `"draft"`, `"live"` or a version number; the default (live → draft) is
*"what will publishing change"*.

- **Two places it belongs:** the **publish dialog** (default sides — list what goes live beside the
  checks) and **version history** (each row's *Compare with current draft*, i.e. `{ from: n }`, before
  *Restore*, which is not undoable).
- **`identical: true`** → say *"No changes since the last publish"* and nothing else.
- **Per document** (`documents[]`): `change` is `added` / `removed` / `changed`; show `title` and
  `fields[]` (title, handle, `seo.*`). Nodes come as `{ id, type, label }` — use `label` ("Heading"),
  never the raw `type`; `changed[].changes[]` names the field (`props.text`, `styles.md`, `moved`, …)
  with `before`/`after`. Clicking a node in the draft side can select it in the editor — the ids match.
- **`headCode.changed`** → *"Custom scripts changed"*; the text is not in the diff on purpose.
  **`customCss`** is two lengths — *"Theme CSS changed"*.
- **Refusals:** `409` `nothing_published` (store never published — hide *compare with live*), `404`
  for a version that is gone.

**Also shipped, nothing to build:** builder pages' lead image and the fixed product page's first photo
now load eagerly at high priority (`docs/BUILDER.md` §13). No API change.

### 🟢 New 2026-11-21 — export the whole store (D53) — needs a screen

`lib/api/store-export.ts` → `exportStore(siteId)` and `previewStoreExport(siteId)`; contract in
`docs/API.md` §19 "Store export". **No migration.** One store whole — products, inventory, customers,
orders, refunds, discounts, shipping, tax, sold files, design — as a zip a self-hosted Markii imports
(`pnpm store:import`). Not the Next.js export: that one is code and holds no data; this one is the data.

- **Who sees the button:** `canExportStore(role)` in `lib/api/org.ts` — owner and administrator only
  (new `store.export` permission). Hide it for everyone else; don't show it disabled with a reason
  about customer data to a role that can't act on it.
- **Suggested home:** website settings, below *Exported storefront*, under a heading like *Move this
  store*. It is a rare, serious act — not a toolbar button.
- **Flow:** call `previewStoreExport` first and show what it will hold from `result.counts` (customers,
  orders, products, digitalAssets) — *"This file will contain 1,204 customers' names, emails and
  addresses."* Then `exportStore`, which asks for a fresh authenticator code (`403 MFA_REQUIRED` →
  `MfaStepUpProvider`, as with storefront keys). Open `result.url` — a **five-minute** link; never store it.
- **Say both clocks beside the download:** the zip link lasts five minutes; the links to sold files
  *inside* it expire at `result.files.linksExpireAt` (24 hours) — import before then or export again.
- **`headCodeLeftOut: true`** → "Your custom scripts are not included; add them again on the new store."
- Copy worth keeping: *"Everything in this store, in one file, to move it to your own Markii. It holds
  your customers' personal data — keep it like a database backup and delete it once it is imported."*
- When the screen ships, add one line to `lib/ops-agents/assistant/help.ts` saying where it is (the
  assistant's help is a contract — don't describe a button that isn't there yet).

### 🟢 New 2026-11-20 — export the storefront as a Next.js app (D53) — screen built

`exportNextApp(site)` in `lib/api/builder.ts` → `{ url, expiresAt, files, bytes, storeUrl, storeLive }`.
The button is on the design editor's Theme tab, beside theme export. Open `url` (a five-minute
zip link — don't store it). **When `storeLive` is false, say so beside the download**: the app reads
the live store, so a draft or paused store exports fine and shows nothing. Copy worth showing:
*"Your store as a Next.js app you host yourself. It reads your catalogue and design live from
Markii and checks out here. Shopper sign-in is yours to add — see the README inside. Members-only
products need a storefront key."* `cms.read`; nothing to confirm, nothing to undo.

### 🔴 New 2026-11-20 — the drawing code moved: `@markii/renderer/*` (D53) — rebase your imports

The renderer is its own Apache 2.0 package now, `packages/renderer/src/`, imported as
**`@markii/renderer/<module>`** (tsconfig path alias, no install). **Every import in the repo was
rewritten in the same change**, so `main` builds — but a branch started earlier will not:

| Was | Now |
|---|---|
| `@/lib/api/money` | `@markii/renderer/money` |
| `@/lib/storefront/themes` | `@markii/renderer/themes` |
| `@/lib/builder/{tree,types,blocks,bindings,styles,tokens,render,views,markdown,sanitize,block-css,to-markdown,theme-package,catalog,format,product-card}` | `@markii/renderer/{same name}` |

Unchanged: `@/lib/api/types` (still re-exports `ThemeId`), and everything server-side in
`lib/builder/` (`store`, `queries`, `lease`, `preview`, …). **Never import an `@/` path from inside
the package** — `lib/builder/renderer-boundary.test.ts` fails `pnpm test` on anything that does.

### 🟢 New 2026-11-20 — storefront secret keys (D53) — screen built

**Backend, typed client, and screen are live (`lib/api/storefront-keys.ts`, website settings →
Exported storefront); needs migration 0050.** A per-store secret an exported storefront's server uses so its signed-in shoppers can buy
members-only products. Suggested home: the store's settings, beside the domain card, under
"Exported storefront".

- `listStorefrontKeys(site)` → `{ keys: [{ id, label, prefix, createdAt, lastUsedAt, revokedAt }] }`.
  Permission `tokens.manage` (owner, administrator, developer) — others get `403`; show the
  permission state, not an empty list.
- `createStorefrontKey({ siteId, label })` → `result.key` is **the only copy that will ever exist**.
  Show it once with a copy button and say so plainly; never put it in a toast, the URL or local
  storage. `high` + **step-up** — `MfaStepUpProvider` handles the `403 MFA_REQUIRED`.
- `revokeStorefrontKey({ siteId, keyId })` — immediate, not undoable, no step-up. Confirm first.
- Copy to show beside the key: *"Put this in your exported store's server environment. Anyone who
  has it can act as any of this store's customers. Never put it in browser code."*

### 🟢 New 2026-11-20 — storefront read API (D53) — no screen needed

Four public `GET` routes on a **store's own host** — `/api/store`, `/api/products`,
`/api/products/{slug}`, `/api/collections/{handle}` (`docs/API.md` §23, shapes in
`lib/storefront/read-api.ts`). They exist for headless storefronts and the coming Next.js export,
not for the dashboard: **dashboard screens keep calling `/api/*` on the platform host**, and nothing
here changes a dashboard response. Worth knowing if you build "view as a developer" or export UI:
`GET /api/store` answers the **published** design as a theme package (no head code), `null` before
anything is published.

### 🟢 New 2026-11-19 — copy a design between stores, export and import theme files (D53) — screens built

**Backend, typed client, and screens are live** (`lib/api/builder.ts`, design editor Theme tab). Contract in
`docs/API.md` §19 "Theme packages". The natural home is the design editor's Theme tab (or a "Design"
menu): *Copy from another store…*, *Export theme*, *Import theme…*.

- **`copyDesign({ siteId, fromSiteId, source?, discardUnpublished? })`** — the store picker should list
  only the stores in `me.storeIds` reach (a scoped member gets `404` for the others). Default `source`
  is `"published"`; on `409 reason: "nothing_published"` offer the draft instead.
- **`exportTheme(site, source)`** → `{ url, expiresAt, images, headCodeLeftOut }`. Open `url` straight
  away (five minutes); never store it. Show `images.external` / `images.unreadable` as a warning list
  (each has a human `where`), and say so when `headCodeLeftOut` — scripts are never in a theme file.
- **Import is three calls**, because the file goes straight to storage (past 4.5 MB a request cannot
  carry it): `createThemeUpload(site)` → `fetch(uploadUrl, { method, headers, body: file })` →
  `importThemeUpload(site, uploadId, { dryRun: true })` to show what will change, then again without
  `dryRun`. A new `uploadId` per file; do not reuse one.
- **Both replace the draft and are not undoable.** On `409 reason: "unpublished_changes"` show a
  confirm ("Your unpublished changes will be replaced") and retry with `discardUnpublished: true`.
  Nothing goes live until the merchant publishes — say that in the success state.
- **`high` risk**: a signed-in person only. API tokens and agents get `403 HUMAN_APPROVAL_REQUIRED`, so
  there is nothing to wire for the brand agent.
- **After a copy**, `sourceHasHeadCode: true` means the source store has custom scripts that were not
  copied. Offer "Copy scripts too", which is `setHeadCode` with the source's code — it asks for a fresh
  second factor, which `MfaStepUpProvider` already handles.
- `savedBlocks.skipped` lists blocks not added because the name was taken or the library is full.

### 🟢 New 2026-11-14 — editor polish: breakpoints, multi-select, copy/paste, saved blocks (D51 M7)

**Owner decision 2026-11-14: M7 is built now**, reversing the same day's "deferred past launch" entry
above. What changed in the editor (`components/builder/`):

- **One breakpoint control.** The top bar's switcher (All · 640+ · 768+ · 1024+) sets both which styles
  the inspector edits and the preview width — each size at its *narrowest* width, so an edit is never
  hidden by an override from a larger size. The old Desktop/Tablet/Phone buttons are gone. The inspector
  says what an unset field inherits ("Inherit: lg (All screens)") and marks fields set at this size.
- **Selection is a list** (`selection: string[]`, last = primary). Layer tree: one tab stop; ↑/↓, Home/End;
  Shift extends, Ctrl/⌘ toggles; Alt+↑/↓ moves the group (`moveNodes`); dragging a selected row drags all.
  The inspector shows `MultiInspector` (duplicate/copy/delete all) for more than one.
- **Keyboard**: Ctrl/⌘+C/X/V/D, Delete, Esc, Ctrl/⌘+Z / Shift+Z / Y. Copy works while read-only.
- **Clipboard** in `localStorage` (`markii.builder.clipboard.v1`), so paste works across pages, tabs and
  stores. Paste/duplicate are one `insertNodes` each — planned by `planPaste` / `planDuplicate` in
  `components/builder/tree.ts`, which are unit-tested against the server's own tree operations.
- **Saved blocks**: inspector "Save as a reusable block"; Add → Saved blocks (insert / delete with
  confirm). `lib/api/builder.ts`: `listSavedBlocks`, `saveBlock`, `deleteSavedBlock`, `insertNodes`,
  `moveNodes`, types `NodeInput`, `SavedBlock`. Library actions are not put on the editor's undo stack.
- **Save state** in the top bar (Saving… / Saved to draft / Last change not saved), one polite live
  region for every announcement, and the tool tabs follow the WAI-ARIA tabs pattern (arrow keys).

### 🟢 New 2026-11-13 — custom scripts, and two refusals any screen can now meet (D51 M6)

- **`lib/api/builder.ts`**: `setHeadCode(siteId, html)` → `{ headHtml, removed }`; `DesignSummary.headHtml`
  and `headHtmlChanged`. **`lib/api/org.ts`**: `canWriteScripts(role)` (`cms.scripts` — owner,
  administrator, developer). Saving asks for a second factor: the step-up modal handles `403
  MFA_REQUIRED` and retries. Show `removed` after saving — it is what the server dropped from the paste.
- Editor: the Theme tab's **Custom scripts** field (explicit Save, not on blur). The publish dialog
  shows `HEAD_CODE_CHANGED` like any warning. Scripts never run in the preview — say so, as the field does.
- **`403 CROSS_ORIGIN_REFUSED`** can now come back from any write: the proxy refuses a cookie-carrying
  request a browser marks as from another origin. Same-origin `fetch` from the dashboard is unaffected;
  a screen that posts to another Markii host (none does today) would be refused.
- **Storefront pages now carry a strict CSP.** A script a storefront server component renders itself
  must take `nonce={await requestNonce()}` (`lib/storefront/nonce.ts`) or the browser blocks it — Next's
  own scripts and the islands get the nonce automatically.

### 🟢 New 2026-11-13 — custom CSS, custom HTML and custom classes (D51 M6)

- **`lib/api/builder.ts`**: `setCustomCss(siteId, css)` and `setNodeCustomClass(...)`; `DesignSummary.customCss`;
  `PageNode.customClass`; block category `advanced` (the `html` block); `FieldSpec` kind `code`.
- **`setCustomCss` refusals to show**: `400 VALIDATION_ERROR` with `details.problems` (a list of
  sentences), and `403 HUMAN_APPROVAL_REQUIRED` for API tokens. **Custom HTML** comes back cleaned —
  re-read the block after saving and show what is stored, not what was typed.
- Editor: the Theme tab has a Custom CSS editor; the inspector has "Custom classes" on every block and
  a code editor for the Custom HTML block (Add tab → Advanced).
- **`StoreFooter` takes `minimal`** like `StoreTop`, and emits the theme CSS last. Cart and account pass
  it; a new page where shoppers type secrets must pass it too, or the merchant's CSS runs there.

### 🟢 New 2026-11-12 — page SEO and agent documents (D51 M5)

- **`PageSeo` gains `ogImage`** (https). **`builder.updatePage` replaces `seo` whole**, so a form must
  send every field every time — the Pages tab's SEO form now owns title, description, share image
  and noindex together (it used to send only title and description, which would have dropped the
  other two on every save).
- **`noindex` now also hides the page from agents** — the sitemap, `llms.txt` and `llms-full.txt` —
  so the toggle reads "Hide from search engines and AI agents". The SEO description is also how
  `llms.txt` describes the page.
- No new client calls: the agent documents are storefront routes, not dashboard API.

### 🟢 New 2026-11-03 — templates, regions and data bindings are built (D51 M4) — review them

Backend and screens both landed (`docs/API.md` §19, "Templates, regions and data binding").
What changed on shared surfaces:

- **Every storefront page now renders `StoreTop` / `StoreFooter`** (`components/storefront/store-chrome.tsx`)
  instead of `SiteHeader` directly — they render the merchant's published header, footer and
  announcement bar, or the fixed header exactly as before. A new storefront page must use them too,
  or it will show a header the merchant replaced. `minimal` is the cart/account variant.
- **The block CSS moved into `ThemeRoot`** (`packages/renderer/src/block-css.ts`), once per page, so several
  builder documents on one page share one cascade. `BuilderPage` emits only its node styles now.
- **`lib/api/builder.ts`**: `DesignSummary` gains `templates[]` / `regions[]` (`SharedDocument`);
  `BlockDescription` gains `bindable` and `requiresScope` and the category `navigation`;
  `BlockRegistry` gains `data` (paths, conditions, repeater sources); `PageNode` carries
  `bindings` / `visibleWhen`; `CheckResult` may carry `kind`. New writes: `customizeTemplate`,
  `customizeRegion`, `setNodeBindings`, `setNodeVisibility`. Reset is `deleteDesignPage`.
- **Editor**: the Pages tab lists templates and regions (Customize / Reset / Restore); the inspector
  has Data (bind a prop — only paths that fit the prop and the document) and "Show only when".
  The preview sends `docId` with a click, and the editor opens that document. **The open document
  lives in a ref written at the moment it changes** (`pageRef`): reads that resolve later — the
  revision poll, a write's refresh — check it before `setPage`, because a poll started for the home
  page could land after a template opened and put the home tree under the template's id (found in
  the browser: a click after Customize selected nothing).

### 🟢 New 2026-11-02 — the brand agent is built (D51 M3) — review it

`components/builder/brand-chat.tsx` (the editor's **Agent** tab, now the default) over the shared
`AgentChat`. What changed on shared surfaces, and what not to break:

- **`AgentKind` gains `"brand"`**; directory rows gain **`surface: "drawer" | "editor"`** — route
  `"editor"` agents to `href` rather than opening `AgentPanel`. The brand agent's `href` is
  `/dashboard/websites?open=design` **in the directory itself** (2026-11-12 — the menu used to append
  it, so other consumers of the directory got the plain list); in that mode the cards open the
  editor. Sessions carry **`siteId`**, and
  `listAgentSessions({ agent: "brand", siteId })` lists one site's conversations.
  `AskAgentButton` for `brand` is a link to that list, not a drawer.
- **`AgentChat` gained optional props** the drawer does not use: `context` (a getter, read at send
  time — the brand agent **requires** `context.siteId`), `onToolResult`, `onStop`, `onBusyChange`,
  `stopSignal`. Draft tools (`builder_*`) render as "… in your draft" lines — they already happened.
- **Stop must call `stopBrandAgent(siteId)` as well as aborting the stream.** The editor's banner has
  its own **Stop agent** button that does both. While a turn runs the editor is read-only
  (`agentBusy` locally, `agentLock.active` from the poll).
- **The agent's edits go on the editor's undo stack** (`invocationId` from each tool result), so Undo
  reverses them like the merchant's own. Edits with no `changes` are skipped — their undo is a `409`.
- **Double submit is guarded** in `AgentChat` (a ref, since `busy` lags a tick), and replies now carry
  real ids; `asUiMessages` repairs the empty ids older transcripts were saved with.

### 🟢 New 2026-11-01 — the design editor and live preview are built (D51 M2) — review them

`/dashboard/websites/[slug]/design`, `components/builder/`. Built backend-side to land M2 in one
change; it is yours to restyle and reshape. What it relies on, and what not to break:

- **It holds no copy of the design.** Every edit is an action; afterwards it re-reads the page and
  reloads the preview. It polls `getDesignRevision` every 2s, so edits from elsewhere (another tab,
  MCP, the brand agent in M3) appear the same way.
- **The preview is an iframe on another origin** (`createPreviewSession` → `url`). It talks back
  only by `postMessage`: `markii:select { nodeId }` and `markii:location { path }`; the editor sends
  `markii:highlight { nodeId, scroll }`. Check `event.origin` against the preview URL's origin.
  Re-mint before the two hours are up (the editor does at 90 minutes).
- **Read-only when `agentLock.active`** or the role lacks `cms.write` (`canWriteCms` in
  `lib/api/org.ts`). `AGENT_EDITING` from any action means the same thing.
- **Undo/redo** is a client stack over `undoInvocation`; redo is the undo of the undo.
- The website page has an **Edit design** button.

### 🟢 New 2026-10-31 — site builder foundation (D51): typed client ready, no screens yet

`docs/API.md` §19, `lib/api/builder.ts` (`BUILDER_API_LIVE = true`). The editor screen, live preview
and brand agent come next (M2–M3); nothing here needs a screen yet, but the contract is live.

- **Reads:** `getBlockRegistry`, `getDesign`, `getDesignPage`, `getDesignRevision` (poll it),
  `getDesignChecks`, `listDesignVersions`. **Writes** are registry actions wrapped as `startDesign`,
  `addBlock`, `insertPreset`, `setNodeProps`, `setNodeStyles`, `setDesignTokens`, `publishDesign`… —
  each returns the new `revision`.
- **Generate the inspector from `editorPanel`** on each block in `getBlockRegistry` — field kinds
  `text`, `markdown`, `number`, `select`, `boolean`, `link`, `image`, `product`, `category`,
  `collection`, `stringList`, `items`. Do not hand-build per-block forms.
- **New error code `AGENT_EDITING` (409)**: the brand agent holds the pen. Make the editor read-only
  and offer Stop; do not show it as a generic conflict.
- **`ThemeRoot` takes `theme`** (the resolved published theme, `data.theme` from `loadSite`) — every
  storefront page passes it so published design tokens apply site-wide. `themeId` still works alone.
- **`ProductCard` takes optional `showPrice`** (default true).

### 🟢 New 2026-10-29 — `*Cents` are minor units now; x402 is USD-only; provenance rendered (D50)

**Done for you, review it:**

- **`formatCents` now formats in the currency's own decimals** — it is `formatMinor` under its old
  name. `priceCents` was always *charged* as the currency's minor unit; display divided by 100, so
  ¥1,500 read ¥15. Nothing changes for USD/EUR/GBP. **Stop treating `Cents` as hundredths
  anywhere**: no `/100`, no `* 100`.
- **New `parseDecimalToMinor(value, currency)`** in `packages/renderer/src/money.ts` — the inverse of
  `decimalMinor`. Use it for any typed price. It refuses more decimals than the currency has
  (`19.999` USD, `1500.5` JPY) instead of rounding.
- **`product-form.tsx`**: price label and placeholder follow the product's currency (`Price (JPY)`),
  and parsing uses the helper above. It used to say "(USD)" for every product.
  **Create** now takes `orgCurrency` from `GET /api/me` and sends `currency` on
  `createProduct` — a new product used to parse and store as USD regardless of the org.
- **`create-website-wizard.tsx`**: hand-added prices parse in the org currency; the zero-decimal
  fallback to USD in `websites/new/page.tsx` is gone.
- **Product page shows provenance** — "Imported from Shopify on … · view original", from the four
  `import*` fields, in `products/[slug]/page.tsx`. Nothing for products made in Markii.
- **x402 is USD-only.** `checkout/session` with `rail: "x402"` answers `409` (rail `unavailable`)
  for a non-USD cart, and the storefront hides "Buy via agent" for non-USD products. The cart
  island (`cart-checkout.tsx`) leaves x402 out of the picker for a non-USD cart and says
  "This store cannot take payment in EUR right now" when no rail is left. Any other rail picker
  should offer x402 only when `currency` is USD.
- **New commit `failed` reason**: *"already imported, or slug … taken, … by a concurrent import"*
  — same meaning as "already imported", just from a race. The import done step lists those
  separately as "Already in the catalog", not as items that need attention.

### 🟢 New 2026-10-23 — import provenance, WooCommerce variations, wizard currency (D49)

- **`Product` gained `importSource`, `importSourceId`, `importSourceUrl`, `importedAt`** (all null
  for a product made in Markii). Read-only. Worth an "Imported from Shopify" line with a link on
  the product page; nothing renders it yet.
- **WooCommerce imports now carry `options`/`variants`** like Shopify. Nothing to change — the
  allocate table already counts variants.
- **A re-run of the same store import** now lists already-imported products in commit `failed`
  ("already imported on site N as …"). Expected, not an error to alarm about.
- **Changed in the wizard (review):** it takes an `orgCurrency` prop (from `getMe` in
  `websites/new/page.tsx`), used for hand-added and template products, which were being created in
  USD. A yen or other zero-decimal org still gets USD there until D49's display/charge mismatch is
  fixed — otherwise a hand-added product would show one price and charge 100× another. Hand-added
  products are now staged at **stock 0 with "Stock not set"** — the form asks for no quantity and
  used to invent 10. The draft list no longer repeats the currency code after the formatted price.

### 🟢 New 2026-10-22 — imports stop inventing data; two components changed for you (D49)

`docs/API.md` §5, `lib/api/import.ts`. The parse response and commit response changed shape, and I
made two small changes to your components so nothing regressed — review them.

- **`ImportParseResult.warnings`** (new) and **`ImportCommitResult.warnings`** (new): merchant
  copy, render verbatim. `STOCK_UNKNOWN` matters most — those products are staged at stock 0 and
  cannot be bought until the merchant sets a count. `failed` entries may now carry `name` (store
  imports) instead of `row` (CSV).
- **`ImportedItem`** gained `stockKnown`, `options`, `variants`. Treat it as opaque and send it back
  to `commitImport` — variants only reach the database through the commit route.
- **Changed in `import-dialog.tsx`:** warnings render at the allocate and done steps through a new
  exported `ImportWarnings`; failed rows show the product name when there is no row number; the
  done step's "N items skipped" reads "need attention", because a failure can now mean "created,
  but its variants were not". `onParsedDraft` also passes `failed` and `warnings`.
- **Changed in `create-website-wizard.tsx`:** imported products are committed through
  `commitImport` (allocated to the new site, categories by `categoryId`) instead of re-created with
  `createProduct`, which had been dropping their currency, SKU and variants. Hand-added and template
  products still use `createProduct`. tempIds are prefixed per import so two imports cannot collide.
  Skipped items and warnings show on the catalog step; commit problems keep the merchant on the save
  step with a notice, like a failed domain claim. `PreviewDraftProduct` gained `importTempId`,
  `currency`, and `stockKnown`.
- **Draft list and allocate table (2026-10-23):** each imported row shows its own currency
  (`formatCents(price, currency)` plus the code) and a **Stock not set** marker when
  `stockKnown === false`. Do not format imported prices as dollars.

### 🟢 New 2026-10-17 — the assistant and the setup checklist (D48); screens built

`docs/API.md` §27 ("The assistant") and §28. Two new things to build against, and one small change
already made to the Catalog panel.

- **The assistant** is selected from **Agents** in the dashboard header: `agentChatEndpoint("assistant")`,
  the same `useChat` transport, session, refusal and allowance handling as the Catalog panel —
  `AgentPanel` takes `agent` and `AgentsHost` mounts both panels from the dashboard layout. It **proposes nothing**, so its transcripts
  never contain `propose_*` parts or cards; tool parts are reads (`setup_status`, `store_health`,
  `read_help`, `get_plans`, `list_stores`) and render as collapsed "checked your setup" rows.
  `GET /api/agents` lists it with **`href: null`**. Catalog still carries
  `href: "/dashboard/catalog"`. Label it **Beta**; it shares the org's allowance with Catalog. Neither agent uses a page dock.
- **Links in its replies are dashboard paths** (`/dashboard/settings/shipping`). Render them as
  in-app links. The backend tests that every path it can be given exists.
- **The setup checklist** — `getSetupStatus()` on Overview (`SetupChecklistCard`). Derived per call, so **refetch after any setup action**; there is no "mark done" or
  "dismiss" endpoint and there is no local tick state. `firstRun: true` leads
  the overview with setup and offers the assistant. First-run lists Account (and each store) once — do not also headline `next`, which repeats a step already in that list. After first run, `next` is the compact card. `status`
  has three values — `not_needed` is rendered as such (a downloads-only store has no shipping), not as
  done. `required: false` steps are "Recommended" and never block `readyToLaunch`. **`canAct:
  false`** means the viewer's role cannot do the step: "ask an owner or administrator", no
  CTA into a page that will refuse them. `agent: "catalog"` on a step → open the Catalog agent from the nav. `title` varies with state (`choose_plan` reads "Update your payment method" when
  past due) — render it, don't map ids to your own copy.
- **Changed for you:** `listAgentSessions` now takes `{ agent }` as its first argument, and
  `AgentPanel` passes `{ agent: "catalog" }`. Without it, assistant conversations would have shown
  in the Catalog panel and resuming one answers `409` (a session only continues with its own agent).

### 🟢 New 2026-10-15 — merchant agents: the Catalog agent is live, screen built (D47)

`docs/API.md` §27, `lib/api/agents.ts` (`AGENTS_API_LIVE = true`). Both agents open from **Agents** in the dashboard header (`AgentsNavMenu`); the drawers are mounted by `AgentsHost` in the dashboard layout.

- **The chat is `useChat`, not a service function.** Transport posts to
  `agentChatEndpoint("catalog")` and sends **only the new message** plus `sessionId`
  (`prepareSendMessagesRequest` → `{ sessionId, message: messages.at(-1) }`). The server owns the
  history; it refuses an assistant or tool part from the client. Read `x-agent-session-id` off the
  first response and keep it.
- **Resuming:** `getAgentSession(id)` returns `messages` ready for `useChat({ messages })` and the
  session's `proposals` with their *current* status. Tool parts in the transcript named
  `propose_*` carry a `proposalId` in their output — join on it to put each card where the agent
  made it.
- **Proposal cards render `diff`, never the model's prose.** `summary`/`rationale` are the agent's
  words — labelled so. Approve → `approveAgentProposal`; Reject → `rejectAgentProposal`.
  `409` with `details.status === "stale"` means nothing was applied: offer "ask the agent again",
  not "retry". `403 MFA_REQUIRED` is the existing step-up modal; the proposal stays `pending`.
  An executed card gets **Undo** — `POST /api/actions/{actionId}/undo` with `{ invocationId }`,
  i.e. the existing `undoInvocation` client — and a link to the audit entry. Once
  `proposal.undoneByInvocationId` is set (2026-10-17) the card reads **Undone** with no button —
  it survives a reload and reflects an undo made from the audit log too.
- **The panel's drawer stays mounted while closed** (`Drawer keepMounted`), because the transcript
  and any in-flight reply live in `useChat`; unmounting on close dropped both while the session id
  survived. The drawer's Escape now closes only the topmost dialog, so Escape on the undo confirm
  or the step-up modal no longer closes the drawer behind it.
- **Before the panel opens:** `getAgentDirectory()` — `configured: false` is *configuration
  required* (Markii's), `allowance.allowed: false` is "this month's beta allowance is used, resets
  on …" (the org's). Two facts; do not merge them. Label the whole thing **Beta**.
- Chat refusals arrive **before** the stream as JSON: `409 QUOTA_EXCEEDED`
  (`details.quota: "agent_tokens"`), `429 RATE_LIMITED`, `503 CONFIGURATION_REQUIRED`, and the
  standing codes. Cookie sessions only; a token gets `401`.
- **Do not start** Inventory / Pricing / Orders agents, Test Lab, or the paid Agent Ops add-on.

**One change with no visible effect:** `PATCH /api/products/:id` now delegates to the new
`catalog.updateProduct` action. Same fields, refusals and response — but every product save is now
in the audit log and undoable from it.

### 🔴 New 2026-10-07 — the G5 storage allowance is enforced; `usage.advisoryOnly` is gone

**Shape change on `GET`/`POST /api/digital-assets`.** `usage.advisoryOnly: true` is replaced by
**`usage.enforcement: { storage: "enforced", delivery: "reported" }`**, and `usage.quota` is now
always present (it was `null` on the live route — the plan was never passed in). `MediaUsage` in
`lib/api/delivery.ts` is updated.

- **Upload can answer `409 QUOTA_EXCEEDED`** when the file would not fit the plan's storage
  allowance. `details` is `StorageQuotaExceeded` (`lib/api/delivery.ts`): show `resolution`.
  `uploadDigitalAsset` now carries `details` on the thrown `ApiClientError` (it dropped them).
  Not 402 — do not put a subscribe button on it; the merchant may already be on Scale.
- **Delivery is shown, never enforced and never billed** — word it as a reference figure.
- **Each download link is throttled to 10 redemptions a day** (`429` on the storefront route,
  not counted against the merchant's own limit). Shopper-facing only; nothing to build.

`components/dashboard/digital-assets-panel.tsx` was minimally updated so it compiles and stops
saying "advisory": per-card notes, the quota resolution in the upload error. Restyle freely.

### 🟢 New 2026-10-07 — `GET /api/settings/email` gained `sendingLimit` (G12)

Every merchant now has a daily sending cap that lifts as their account establishes:
`sendingLimit: { tier, dailyLimit, sentLast24h, remaining, reason } | null` (`EmailSettings` in
`lib/api/email.ts`). A send over it is recorded as `capped` and shows on the order timeline as
`email_failed` with the reason — so a merchant asking "why didn't my customer get a receipt?" has
the answer in two places already. **On `/dashboard/settings/email` as of 2026-10-08.** Show
`reason` as-is — it says what lifts the cap. `established` has no cap (`dailyLimit` null) and
needs no UI; `null` means unknown — render nothing rather than "no cap".

### 🟢 New 2026-09-15 — a fourth held state: `standing.state === "suspended"` (G12)

`AccountStanding` on `/api/me` and `/api/billing/subscription` (`lib/api/billing.ts`) has a new
member, **`{ state: "suspended", message, since }`** — Markii itself has held the org, by an
operator's decision. **It outranks every billing state**, so a paying merchant can be `suspended`.
Writes answer **`403 ACCOUNT_SUSPENDED`** (`details: { resolution, standing, since }`); reads work.

**Render it above everything, on every page, as an error band with a support link and nothing
else** — no plan picker (not a 402; paying does not lift it) and no "ask your administrator" (not
`FORBIDDEN`; their role is fine). `message` is the whole merchant-facing copy; the API sends no
reason on standing — the merchant reads the grounds in **their own audit log**, where the
`platform.suspendOrg` entry appears with actor `{ type: "operator", name: "Markii operator" }`
(`AUDIT_ACTOR_TYPES` in `lib/api/org.ts` gained `"operator"`; `audit-log.tsx` labels it
"Markii"). **A minimal branch was added to `trial-banner.tsx`** so the compiler and the merchant
both see the right thing — restyle it as you see fit; the copy rules above are the constraint.

**The operator screens are built** — `app/(admin)/admin/*`: overview, organizations, sign-ups,
and the org page with `components/admin/suspend-controls.tsx`. Own shell (`components/admin/
admin-shell.tsx`), own layout with the same sign-in → MFA gate as the dashboard, then
`me.operator` (new on `MeResponse`): a non-operator sees a plain "not a platform operator" page.
The only link in from merchant navigation is `OperatorLink` in `sidebar.tsx`, rendered when
`me.operator` is true. `lib/api/admin.ts` is the typed service; `lib/api/server.ts` has the
in-process wrappers. Styled to the existing primitives and deliberately plain — restyle freely,
but keep it off merchant navigation for everyone else.

**2026-09-25: the admin org page has a Members panel** (`components/admin/staff-mfa.tsx`) with
each member's MFA state and a **Reset MFA** control (`resetPlatformMfa` in `lib/api/admin.ts`;
`PlatformOrgView.staff[]` is new). The form requires a note on how identity was confirmed, and
the success line says a notice was *queued* to `noticeTo`, because the send is post-commit and
not confirmed. **Do not offer Reset MFA on the operator's own row** — the action refuses it
(`403`) so an operator's password alone cannot strip their second factor. Pass `operatorUserId`
from `GET /api/me`.

**Two small fixes in existing files while building this, both worth knowing about:**

- `audit-log.tsx` no longer offers **Undo** on an operator's row — `lib/org/audit.ts` masks
  `undoable` when `actor.type === "operator"`, because undo runs under the reader's own permission
  and no staff role holds `platform.operate`; the button could only ever be refused.
- `app/(dashboard)/dashboard/page.tsx` imported `getReadinessOverview` from `lib/api/readiness`
  (the **browser** client) rather than `lib/api/server`, so the server render fetched with no
  cookies and the overview's Readiness card read *"Authentication required"* for every merchant.
  It now uses the server wrapper. Pre-existing and unrelated to suspension; found by looking at
  the page.

### 🟢 New 2026-09-15 — API tokens are rate limited on the REST routes; the dashboard is not affected

`Authorization: Bearer mk_…` calls to any `/api/*` route now carry `RateLimit-Limit` /
`RateLimit-Remaining` / `RateLimit-Reset` and can answer `429 RATE_LIMITED` (the same envelope as
the auth limits, `details.retryAfterSeconds` + `Retry-After`) after 300 requests in a minute
(`docs/API.md` §16). **Cookie sessions are not counted and carry none of these headers**, so
nothing the dashboard calls through `lib/api/*` changes — no screen needs a `429` branch it did
not already have from 2026-09-13. The one place this is visible to a merchant is the tokens
screen: a client reporting `429` from a route (rather than a JSON-RPC error from `/api/mcp`) has
spent that token's REST budget, and the fix is a narrower token per client, not a broader one.

### 🟢 New 2026-09-14 — collections have storefront pages; `Bundle.collections` in the previews

`/collections` and `/collections/{handle}` are live (§23) — backend-owned, nothing to build. Two
things become visible from the dashboard: **`Bundle` gained an optional `collections` list**, so
`generatePreview`'s `llms.txt` and sitemap panes show a `## Collections` section for a saved site
that has published any (the create-site wizard passes none and is unchanged); and the storefront
header nav gains a "Collections" link once one is published, which matters to themes work (§1).
The collections screen's "published" toggle now does something a shopper can see — the create form
and the catalog list say a published collection appears at `/collections` and in the storefront
header. The catalog list can publish or hide an existing collection (`updateCollection`,
`catalog.write`) without opening a second editor.

### 🟡 New 2026-09-14 — `standing.state` can be `past_due` (D10); the banner already handles it

`AccountStanding` gained a variant: `{ state: "past_due", message, dunning }`, where `dunning`
carries the rung (`grace` → `restricted_growth` → `restricted_writes` → `suspended`), `since`,
`day`, `nextStep`, `nextStepAt` and `holds`. **A non-exhaustive switch on `state` now has a fifth
case** — TypeScript flagged `components/dashboard/trial-banner.tsx` and the backend change added
the branch there (warning band while nothing is held, error band once something is, the next date
stated, and a link to **update the card** — never "choose a plan", which would sell a paying
merchant the plan they have). Check any other place that switches on `state`.

One thing to build when touching `/dashboard/billing`: the card-update path is where every dunning
refusal points, so it should be reachable in one click from the banner and render `standing`
above the plan picker when `past_due`. Refusals are `402 PAYMENT_PAST_DUE` with
`details.dunningStep` — render the message; do not map it onto the trial copy. Contract:
`docs/API.md` §17 *Dunning*.

### 🟢 New 2026-09-13 — billing address form; `tax` on the subscription read (G3)

**Built 2026-09-20.** The form sits on `/dashboard/billing` above the plan picker, via
`updateBillingAddress` in `lib/api/billing.ts`. Owner / administrator only (`billing.write`).
`state` is required for US and CA. The current value is `billingAddress` on
`GET /api/billing/subscription`. It is an action: it lands in the audit log and is undoable back
to a previous address. **Not** `PATCH /api/org` — that route does not accept it.

`tax.message` is rendered on the same card, keyed on `tax.reason`. The plan-change preview shows
"incl. $X tax" when `taxMinor` is present (already inside `amountDueMinor`) and flags
`requires_location_inputs` as an untaxed amount.

Types in `lib/api/billing.ts` (`BillingAddress`, `PlatformTax`, `updateBillingAddress`) and
`lib/api/org.ts`; contract in `docs/API.md` §17 *Sales tax on Markii's own subscription*.

### 🟢 New 2026-09-13 — sign-up, sign-in and reset can answer `429 RATE_LIMITED`

Per client address and per email (per email *domain* on sign-up). The envelope is the usual
`{ error: { code: "RATE_LIMITED", message, details: { retryAfterSeconds } } }` with a
`Retry-After` header, and the message is already what a person should read — *"Too many attempts.
Try again in 3 minutes."* `components/auth/auth-form.tsx` renders `caught.message`, so **it
already shows correctly with no change**. Two things not to do: do not map `429` onto the
"invalid email or password" copy (the password may be right; the answer is *wait*), and do not
show a per-account message — the limiter deliberately says the same thing whether or not the
account exists. Contract in `docs/API.md` §16.

### 🟢 New 2026-09-13 — storefronts have search (G6); nothing in the dashboard changes

**No typed service, no constant to flip, no screen to build** — this is a storefront surface (§23,
backend-owned). Listed so the two places it becomes visible from the dashboard are not a surprise:

- **The storefront header now carries a search box** on the home, category and product pages — a
  plain `GET` form to `/search?q=`, styled through `.sf-search` in `packages/renderer/src/themes.ts`. If
  you are working on themes (build order §1), it is part of the header every theme lays out;
  the `stacked` header variant already centres it with the rest of `.sf-header-actions`.
- **`llms.txt` and `agent.md` gained a line and a section** advertising `GET /api/search?q=`, so
  the create-site wizard's preview panes (`generatePreview`) show it. That is the document the
  store really serves — no preview-only copy.

The JSON shape (`priceMinor` + `currency`, `membersOnly`) is documented in `docs/API.md` §18.4 and
rendered in `agent.md` itself; the dashboard has no reason to call it.

### 🟢 New 2026-09-08 — `GET /api/billing/usage` gained `t12AsOf`

**Additive; nothing that ignores it changes.** `t12AsOf` says where the trailing-twelve figure came
from: `null` means it was summed live for this request, a timestamp means it came from the nightly
§4.5 rollup and is at most a day old.

Worth rendering **only where the number carries a decision** — a "how close am I to my threshold"
surface should be able to say "as of 02:00" rather than implying live. Everywhere else it is noise.
The current-period figures are always live and unaffected.

`UsageResponse` in `lib/api/billing.ts` is typed for it. The threshold meter on `/dashboard/billing`
renders it under the trailing-twelve total — "as of …" when the rollup supplied the figure, "Live
figure" when this request summed it. Period metrics stay unlabeled.

### 🟢 New 2026-09-08 — `POST /api/auth/update-email` is live

Starts moving an account to a new address. It **requests** a change and never applies one, which is
why the response is `{ ok, pending, message }` — `pending`, deliberately not `email`, so a screen
cannot render it as the account's address before both confirmations land.

Supabase's *Secure email change* is on, so this sends **two** emails — one to the current address and
one to the new one — and the change needs both. Tell the user to check both inboxes; the copy in
`message` already says so. Refuses with `400` when the address is the one already on the account.

The form is on `/dashboard/settings/account` via `updateEmail()` in `lib/api/auth.ts`. It shows
`pending` as a destination waiting on confirmation, never as the address on the account.

### 🟢 New 2026-09-20 — username and organization name are writable

`POST /api/auth/update-name` and optional `name` on sign-up. The value is a display name — a person
or a company — **not a unique handle** and not the storefront slug.

- Sign-up: `signUp({ email, password, name })`. The name seeds `user_metadata`, the owner staff
  row, and the first org's name.
- Account: `updateName({ name })` for the signed-in user (every role). `updateOrg({ name })` for
  the current organization's company name (owner / administrator). Changing either does not
  change `{slug}.{ROOT_DOMAIN}`.

`GET /api/me` already returned `user.name` (`string | null`) and `org.name`. The sidebar prefers
the username over the email once one is set.

### 🟢 New 2026-09-08 — `billing.invoiceAssessments` accounts for every assessment

If a screen invokes `billing.invoiceAssessments` and renders the outcome, **`skipped` means
something wider than it used to.**

The action stops at the first Stripe failure rather than working down the list — the next call would
fail identically. What changed is that the assessments it never reached used to appear in **neither**
`billed` nor `skipped`: they simply vanished from the response. A run reported as `3 billed, 1
skipped` against ten outstanding periods gave no hint that six were untouched. They are now named in
`skipped` with a reason saying so.

So `skipped` now mixes two kinds of entry, and the `reason` string is what tells them apart:

- **Refused** — nothing owed, no subscription for the line to ride on, a currency mismatch with no FX
  provider. These are decisions, and re-running changes nothing until the cause is fixed.
- **Not attempted** — the run stopped before reaching it. Still unbilled, and the next monthly sweep
  retries it.

**Render the reason rather than a count.** "4 skipped" now covers both, and they call for different
merchant action — one needs them to do something, the other needs them to do nothing.

`billed` also carries zero-fee periods, which are *settled* rather than charged: `feeMinor: 0` with
`invoiceItemId: null`. That is the same distinction `FeeAssessment.stripeInvoiceItemId` documents —
an invoiced row with no item means "under the threshold, nothing owed", not "unpaid".

Nothing else in this change is visible to a screen. The Stripe API version moved to
`2026-07-29.dahlia` and MCP gained `resources/*`, both server-side only; no response shape moved and
no `lib/api/*` type changed.

### 🟢 New 2026-09-07 — account sessions are live, and §16 is finished

`listSessions()` and `revokeSession(id)` in `lib/api/org.ts` now call real routes;
`ORG_SESSIONS_API_LIVE` is `true`. That was the **last** `*_API_LIVE` constant in §16 still
`false`, so every §16 service is now callable.

**They are the signed-in user's own devices, not the org's.** No role can list or revoke anybody
else's — removing a colleague is `deleteStaff`, which ends their access on their next request.
The screen is `/dashboard/settings/account` — a personal-security surface, not under Team, visible
to every role. Team links here rather than listing devices.

**`SessionRecord.userAgent` is now `string | null`.** It was typed `string` while the route did
not exist, which would have made TypeScript forbid handling the case the API really returns — a
client may send no `User-Agent` at all. Render a fallback ("Unknown device"), and treat `ip` the
same way; it was already nullable.

`revokeSession` returns `{ deleted, id, wasCurrent }`. **`wasCurrent: true` means the user just
signed themselves out** — redirect to `/sign-in` rather than refetching the list against a cookie
that no longer refreshes. Revoking the current session is deliberately allowed, because that is
how a "sign out everywhere" button is built.

⚠️ **Do not label a revoke as instant.** Deleting the session kills its refresh chain immediately,
but an access token already issued stays valid until it expires (an hour on Supabase's default).
"Signed out" is accurate; "device cut off immediately" is not, and §16 explains why closing that
window is not worth a denylist on every authenticated request.

Both routes are **cookie-only** and answer `401` to an API token, like `GET /api/me`. Nothing in
the dashboard hits them with a token, so this only matters if a screen is ever driven by one.

### 🟢 New 2026-09-06 — the org audit log is live, and its planned type was wrong

`listOrgAudit(filters)` in `lib/api/org.ts` now calls a real `GET /api/org/audit`.
`ORG_AUDIT_API_LIVE` is `true`. The screen is `/dashboard/settings/audit` — next to Team,
gated on `owner` / `administrator`. Undo hangs on `outcome.undoable` here; that is the
honest home for it, because the audit row is what an inverse can read.

**`OrgAuditEntry` changed shape, and the old one would not have compiled against the real
response.** It declared a flat `entity: string` with a single `before`/`after`, which cannot
describe what the log holds: one invocation records a field-level diff that may touch several
fields across several entities. It is now `entities: { type, id }[]` plus the full
`changes: AuditChange[]`. A bulk edit renders as one entry listing every row it touched.

Three things to render honestly:

- **`actor.name` is `string | null`.** Null means the staff row or token is gone — show `actor.id`,
  never a placeholder name. `system` names itself.
- **`ip` and `userAgent` are `string | null`, and null is common and correct** — not a loading
  state. Only HTTP callers have an address; the scheduled sweep and anything run from a shell
  record none. Show "—", and never present an IP as proof of who someone was.
- **`ok: false` entries are refused attempts, not failures to hide.** They are the incident view;
  `?ok=false` filters to them, and `error.code` / `error.message` say why. Style them as refusals
  rather than errors — nothing broke.

Filters: `actorType`, `actorId`, `actionId`, `riskTier`, `ok`, `from`, `to`, `page`, `limit`. An
unknown `actorType` or `riskTier` is a `400` by design, so drive those from the exported unions
rather than free text. **There is no entity filter** — you cannot ask for "every change to product
42". Each row carries the `entities[]` it touched, so a per-entity history means filtering client
side over a page, which is wrong for anything but a small org. If a screen needs it, say so and the
backend adds it with an index; do not fake it with a large `limit`. The response carries `total` counted under the same filters, so
"showing 20 of 340" is honest.

**Permission:** `org.audit`, held only by `owner` and `administrator`. Gate the nav entry on the
role from `GET /api/me` so a `viewer` is not shown a tab that will 403. This is deliberate — the
audit log carries every action's input, which is not part of a reporting seat.

### 🔴 Two frontend jobs left over from the backend work — for whoever picks up screens next

**1. DONE — `deploySite` host attach** (2026-08-17). Both call sites read `hostAttached` /
`hostProblem`. `hostAttached: false` is published-but-not-reachable: the UI shows `hostProblem` and
offers deploy again, rather than a storefront link that fails TLS.

**2. DONE — the abandoned-cart toggle** now sits with the other site switches in
`site-controls.tsx`. Left here as a note only because the feature is **opt-in and useless without
it**: the sweep ships off by default, so shipping the backend alone would have been a feature no
merchant could reach.

**3. DONE — Settings → Email D44.** `CustomerEmailStatus.code` gained **`unverified_sender`** and
lost `domain_verification_required`. Mail still sends from the storefront's Markii address, so that
state is badged "Sending — unverified", never as an error. Empty-domain copy no longer says mail is
not going out. `fallbackSender.ok: false` is a Markii incident panel — not a "verify your domain"
call to action, because none of the merchants in that state can fix a broken shared sender.

Readiness gains **`UNVERIFIED_SENDING_DOMAIN`** — `warning` on a live store, `opportunity` before
launch. Deliberately **not** critical: receipts are sending, just not from the merchant's own
domain, and overstating it teaches merchants to discount the whole list. It stays silent when SES
itself is unconfigured, since that is Markii's problem and a finding the merchant cannot act on is
noise.

`Site` gains `domainStatus`, `domainVerifiedAt`, `domainCheckedAt`, `domainLastError`. Readiness
gains **`DOMAIN_NOT_VERIFIED`** (warning), which replaces `NO_CUSTOM_DOMAIN` for a pending claim —
telling someone to "connect a domain you own" when they already tried is how a checklist teaches
people to ignore it.

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
| ~~Threshold meter hardcodes `/100`~~ ✅ **fixed 2026-07-30** | `components/dashboard/threshold-meter.tsx` | Uses `formatMinor(amountMinor, currency)` from `packages/renderer/src/money.ts`, which derives the exponent from the currency (**D31**). `formatCents` stays USD-shaped for the legacy §1–8 `Cents` fields |
| ~~No cart, variant picker, or checkout~~ ✅ **built** | `components/storefront/add-to-cart.tsx`, `cart-checkout.tsx` | The three sanctioned islands exist. Recurring-membership purchase is the remaining storefront flow |
| ~~Every live endpoint gated off~~ ✅ **fixed 2026-08-02** | `lib/api/{readiness,billing,commerce}.ts` | Constants flipped per endpoint group against the routes that actually exist, and the drifted response types corrected. See the two-sided-flip note below |
| ~~§24 email had no client or screen~~ ✅ **fixed 2026-08-02** | `lib/api/email.ts`, `/dashboard/settings/email` | The route and its five actions shipped 2026-08-02 with nothing calling them, while `lib/email/` told merchants to go to a page that did not exist |
| ~~Invoices screen stubbed on `configuration_required`~~ ⚠️ **unblocked 2026-08-07** | `/dashboard/billing` | §17 is LIVE in full. Plan, card, meter, and invoices share this screen. Old `/dashboard/settings/billing` and `/dashboard/settings/subscription` redirect here |
| ~~Org switcher was a placeholder~~ ✅ **built 2026-08-03** | `components/dashboard/sidebar.tsx` | The sidebar card said "org switching is coming soon with Phase A auth" long after `POST /api/org/switch` shipped. Now a real switcher, shown only when the user belongs to more than one org. Identity is resolved **once in the layout** and passed to both shells, so the rail and the mobile drawer cannot disagree about which org is active |
| ~~Team settings was a stub~~ ✅ **built 2026-08-03** | `/dashboard/settings/team` | Staff with inline role changes, invites against the plan's seat limit, and scoped API tokens. **Audit** is now its own screen (`/dashboard/settings/audit`, 2026-09-06). **Account** (`/dashboard/settings/account`) holds username, org name (owner/admin), email change, and the caller's own sessions |
| ~~Orders list is genuinely blocked~~ ✅ **unblocked** | `/dashboard/orders` | `GET /api/orders` ships; the screen exists. Settlements live at `/dashboard/orders/settlements` |
| ~~Collections tab and discounts were stubs~~ ✅ **built 2026-08-03** | `/dashboard/catalog?tab=collections`, `/dashboard/discounts` | Collections list can publish or hide (`updateCollection`, `catalog.write`) now that storefront `/collections` exists. Discounts show derived `status`, redemption counts, and a **Fully redeemed** badge — an exhausted code still reads as active by its dates and only fails when a shopper tries it |
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
that one is settled rather than assumed. **It is cookie-only** (2026-09-06): an API token against
`/api/me` is `401`. Identity for the dashboard comes from the session cookie; tokens authenticate
`/api/mcp` and `/api/*` writes, not this boot call.

**Themes are done end-to-end** — four defined in `packages/renderer/src/themes.ts`, wired through the
create wizard, site controls, `PATCH /api/sites`, and the generators. They depend on the
`sites.themeId` column, so if every websites screen 500s against a database provisioned before
2026-07-30, that migration is the reason (`docs/BACKEND.md` §0), not your code.

---

## Your scope for launch

The team is two people, so launch is a deliberate subset of the full plan
(`docs/DECISIONS.md` §G10). **In scope:**

| Area | Screens |
|---|---|
| **Auth & org** (Phase A) | Sign-up, sign-in, reset, org switcher, staff list, invites, role management, **audit log**, username / org name, settings shell |
| **Billing** (Phase B) | Plan & subscription, invoices, payment method, billing address, **threshold meter**, upgrade flow, dunning banners |
| **Commerce** (Phase C) | Products **with variants**, inventory, collections, customers, orders + timeline + refunds, discounts, tax & shipping settings, digital delivery |
| **Storefront** | Cart, variant picker, checkout — plus **3–4 polished themes** |
| **Readiness** | Score card, issues list, issue drawer |
| **Catalog agent** | Header **Agents** menu; propose → approve. Beta |
| **Assistant** | Header **Agents** menu; read-only. Beta |
| **Brand agent** | Site editor Agent tab. Draft edits; merchant publishes. Beta |
| **Setup checklist** | Overview card from `GET /api/setup` |
| **Site builder** (D51 M1–M7) | `/dashboard/websites/[slug]/design` — editor, preview, templates, SEO, custom CSS/HTML/scripts, saved blocks |

**Deferred past launch — do not start these:** Channels, Agent Test Lab, the full
analytics funnel, native email campaigns. The Catalog, assistant and brand agents (§27) are in
launch scope and built.

---

## What is left — read this first (2026-08-09)

**Every backend contract in the launch scope is LIVE.** Nothing below is blocked on an endpoint;
if something refuses, it is a *deliberate* refusal that is documented, not unfinished work.

### 1. Storefront themes — the one genuinely launch-critical gap

**What exists:** four theme ids (`studio`, `atlas`, `noir`, `bloom`) wired end to end — stored on
`sites.themeId`, resolved by `getTheme`, applied through `theme-root.tsx`, and emitted into
generated pages. The plumbing is done and works.

**What does not:** `ThemeTokens` is **colours, fonts, radius, and spacing only**
(`packages/renderer/src/themes.ts`). All four render the *same layout*. That is one theme with four
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

- **Search** — `/search?q=` (page) and `GET /_sites/{slug}/api/search?q=` (JSON), built
  2026-09-13. Server-rendered; the header form is the whole interaction. Not something to build,
  something to keep when restyling the header.
- **Recurring membership purchase** — `POST /_sites/{slug}/api/checkout/subscription`. Requires a
  signed-in shopper, cannot share a cart, quantity is capped at 1. The one-off route returns `409`
  with `useEndpoint` pointing here.
- **Shopper account area** — `GET /_sites/{slug}/api/account/memberships` and the cancel-renewal
  route. A member who cannot stop their own renewal is a support ticket per cancellation.

### 4. Not to be built

Add-on **purchase** (`409`, the products do not exist), Channels, Test Lab,
native email campaigns. Email surfaces must say mail is not configured rather than imply it was
sent. (M7 editor polish came off this list on 2026-11-14 — the owner had it built; see below.)

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

Then, in the order a merchant meets them, all on **`/dashboard/billing`**: plan comparison →
**proration preview → confirm** (two calls, never one; **changing a plan requires MFA**) →
**first-invoice Payment Element** (`confirmPayment` with the `clientSecret` from confirm) → card on
file via `setDefaultPaymentMethod` → threshold meter, invoice history, and invoice detail. Dunning
banners key off **`standing.state === "past_due"`** (D10, 2026-09-14 — `TrialBanner` already renders
it) rather than `subscriptionState.code`; `past_due` **still grants access** for the first two
weeks, and the storefront serves for a month — never lock a merchant out over a card Stripe is
still retrying.

Two screens that need care rather than effort, and one that is missing:

- **Billing address (G3, 2026-09-13).** Not built. Without it every merchant is invoiced untaxed;
  see the 🔴 entry above.
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

**Money:** integer minor units, explicit currency, no float maths. Use `packages/renderer/src/money.ts` and
`components/ui/money-text.tsx`. New fields use a `Minor` suffix; older `Cents` fields in §1–8 stay.

**Never call Supabase Auth from the browser.** Sessions are httpOnly cookies, never `localStorage`,
because merchant custom code runs on storefronts and XSS there must not reach an admin session — and
`createBrowserClient` cannot deliver that, whatever package it ships in. Cookies written by
`document.cookie` **cannot be `HttpOnly`**, so a browser-side `signInWithPassword` looks compliant
and isn't. Post to `/api/auth/*` and let the server set the cookie (D30). The same rule covers
storefront customer accounts in Phase C.

**Money formatting derives its exponent from the currency.** Never hardcode `/100` or
`minimumFractionDigits: 2` — `Organization.currency` is merchant-set, and JPY/KRW have no minor
digits, so a fixed divisor renders them 100× wrong (D31). `formatCents` in `packages/renderer/src/money.ts` is
currency-aware too since 2026-10-29 (D50) — the legacy §1–8 `Cents` fields are the currency's own
minor unit, like everything with a `Minor` suffix.

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
