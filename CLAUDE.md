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
pnpm lint             # the RLS deny-by-default check, then eslint — in that order
pnpm test             # unit tests — pure money/rule functions, ~1s, no deps
pnpm test:integration # real HTTP + real DB; needs a dev server (see tests/README.md)
pnpm db:push          # push Drizzle schema (dev only — see docs/DECISIONS.md D6)
pnpm db:migrate       # apply generated migrations (needs session-mode DIRECT_URL)
pnpm db:seed          # seed demo data (3 sites, ~30 products, orders, traffic)
pnpm storage:init     # create the two Storage buckets — NOT in the migration chain
pnpm stripe:prices    # report the plan Prices on Stripe; --apply creates the missing ones
```

**The RLS check runs before eslint, and the order is the point.** It used to be
`eslint && pnpm check:rls`, so when a toolchain break stopped eslint from
running at all — TypeScript 7 outpacing `typescript-eslint`, 2026-08-15 — the
deny-by-default check silently stopped running with it. A security check must
not be gated on a linter's plugin compatibility. `check-rls` degrades on its own
terms without a database (static scan runs, live scan reports itself skipped),
so putting it first costs nothing. **CI already keeps them as separate steps** —
eslint in the fast job, `check:rls` in the integration job where a database
exists — so this only closes the local gap.

**TypeScript is pinned to `6.0.3`, deliberately not `^6`.** `typescript-eslint`
cannot use the TS 7 API (typescript-eslint#10940), and TS 7 landing in a dep
bump turned eslint off across the whole repo without failing anything that was
being watched. Side-by-side does not work here: TypeScript is a **peer**
dependency of typescript-eslint, so there is no dependency edge a pnpm override
can redirect — it always resolves to the root copy. The exact pin is so a
`^`-range does not silently walk back onto 7. **Unpin once typescript-eslint
ships TS 7 support**, and re-run `pnpm lint` to confirm before trusting it.

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

**Billing is scheduled now** (`docs/API.md` §25). `GET /api/cron/billing` (`0 3 1 * *`,
`vercel.json`) closes every finished period via the new **`billing.closePeriod`** action, then runs
`billing.invoiceAssessments` for every org holding an unbilled assessment — including ones stranded
by an earlier failure. Two steps, never merged: close measures, invoicing charges, so Stripe being
down cannot corrupt a measurement. Per-org failures are recorded and stepped over, and the run
answers `200` with `orgsFailed` rather than making Vercel retry the whole sweep.

**The cron is the one place a `system` actor is minted from an HTTP request**, and that matters
because a system actor is granted every permission and has MFA step-up waived. Both bypasses used to
rest on system actors being "never reachable over HTTP"; `CRON_SECRET` now carries that weight
alone (`lib/cron/auth.ts` — refuses when unset, refuses under 32 chars, constant-time compare).
Unset, nothing is billed at all: **it refuses rather than running open** (D41).

**Still nothing else is scheduled** — no T12 rollup, no abandoned-cart timer, no dunning sweep of
Markii's own. Membership status stays derived per request for exactly this reason.

**SES is live as of 2026-08-11 — the platform gate is closed, the merchant gate is not.**
`lib/email/` has the SES v2 transport (hand-rolled SigV4 over `fetch`), per-merchant sending
identities, the suppression list, a signature-verified SNS bounce webhook, and the five
transactional templates — wired into `orders.*` and checkout completion (§24).

**Production access was granted in `us-west-2`, and everything in SES is per-region** — access,
identities, configuration sets, quotas. `AWS_REGION` must name that region or SES is still
sandboxed: sending "succeeds" only to verified addresses and merchant identities verified elsewhere
do not exist. Nothing in the code can detect that; the credentials are valid, the region is wrong.
Verified end to end by a live send to `success@simulator.amazonses.com` carrying
`SES_CONFIGURATION_SET`, which proves the config set exists because SES refuses an unknown one.

**Customer mail sends even before a merchant verifies a domain** (D44, 2026-08-16 — this amended
G1). Without one, `sendMerchantMail` falls back to the storefront's own
`accounts@{slug}.{ROOT_DOMAIN}` address: still SES, still the store's name, **never bare
`markii.shop` and never Resend**. It applies to *all* merchant mail — receipts, shipping and refund
notices, digital delivery, account mail — because a store that takes an order and sends nothing is
broken, and for a digital product the missing email *is* the product. Silence is the worse failure.

**The verified domain always wins when it exists**, and `UNVERIFIED_SENDING_DOMAIN` (§9) nags until
it does — `warning` on a live store, `opportunity` before that. Deliberately not `critical`: mail is
*sending*, and overstating it teaches merchants to discount the whole list.

**It is not reputation isolation.** SES covers subdomains under the parent identity, so DKIM signs
as `markii.shop` and bounce rates are account-wide regardless — one merchant's bad list can still
cost every merchant their receipts. That is why suppression stays load-bearing and why D43 keeps
*campaigns* off this path entirely.

**The feedback loop is wired end to end as of 2026-08-15.** Simulator sends to
`bounce@` and `complaint@simulator.amazonses.com` (labelled, so each is traceable) produced both
SNS notifications, which confirms the configuration set really is subscribed to `BOUNCE` **and**
`COMPLAINT` — something the SES-scoped IAM key cannot read back, so it was verified by observation
rather than by API. Simulator mail does not touch reputation or the daily quota.

```
send → SES → config set → SNS topic → HTTPS subscription → /api/webhooks/ses → suppression list
```

**Every link in that chain now exists** (verified in the AWS console 2026-08-15). The SES-scoped IAM
key cannot read most of it back — no `sns:ListTopics`, `ses:ListEmailIdentities`, or
`ses:GetConfigurationSetEventDestinations` — but **`ses:GetEmailIdentity` *is* permitted**, because
`refreshIdentity` needs it. So an identity's verification and DKIM status are checkable by API given
the domain name; only the SNS subscription and the config set's destinations require the console. Config set `my-first-configuration-set` publishes
**Hard bounces and Complaints** through destination `markii-suppression-feed` to topic
`markii-ses-feedback`, whose one subscription is `https://markii.shop/api/webhooks/ses`, HTTPS,
**Confirmed**. Hard-bounce-only publishing matches `suppressionSignals`, which suppresses
`Permanent` bounces and every complaint and deliberately ignores `Transient` ones. The endpoint
answers `403` to an unsigned body, which is `verifySnsMessage` working.

**Wired is not the same as observed, and the loop has never carried a real event.**
`email_deliveries` is empty and no merchant sending identity exists, so nothing has ever been sent
and nothing has ever bounced. That is the honest state rather than a defect.

**The observation that would close it is narrower than it looks.** A bounce only suppresses if the
app *sent* the mail: the webhook maps the SNS message id back to an `email_deliveries` row to find
the org, and an unmappable one returns `{ suppressed: 0, reason: "unknown_message" }`. So a raw send
to `bounce@simulator.amazonses.com` from outside the app proves nothing — it would write no
suppression even with the chain working. It takes a merchant with a verified sending domain sending
**through** the app.

Nothing here notices if that chain later breaks — a deleted subscription or an edited config set
would be silent, and the SES-scoped key cannot check. Re-verify in the console after any AWS change.

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

**Verified end to end 2026-08-10** — `tests/integration/membership-renewal.test.ts`, 9 tests driven
by synthetic *signed* Connect events, including a redelivery arriving under a **new event id**,
which is precisely the case `stripe_webhook_events` cannot catch. All passed first run; the renewal
machinery had no bugs. What they do **not** prove is that real Stripe deliveries verify — the route
HMACs with whatever secret is configured and cannot know which endpoint issued it, so a mode-matched
`STRIPE_CONNECT_WEBHOOK_SECRET` is still required and still unset in this deployment.

**The purchase flow is `/_sites/{slug}/api/checkout/subscription`**, separate from
`/checkout/session` because a subscription opens no PaymentIntent and reserves no stock; the one-off
route points a subscription cart at it with a `409` carrying `useEndpoint`. It requires a signed-in
shopper — a renewal months later has no session to attach to. **No membership row is written at
checkout**: there is no honest state for "exists but not yet paid", so the subscription's metadata
carries the link and the first `invoice.paid` creates the membership, re-checking those ids against
Markii's own rows because a merchant controls metadata on their own account. A subscription may not
share a cart — it settles through Stripe's invoice, not the PaymentIntent, so a mixed basket would
need two payments for one order.

**Members can cancel their own renewal** (`DELETE
/_sites/{slug}/api/account/memberships/{id}/renewal`). It stops the renewal, never the membership:
access runs to `endsAt`, and `renewalCanceledAt` stays distinct from `revokedAt` because *"I
cancelled"* and *"the merchant removed me"* are different facts. The local row is written **only
after Stripe confirms** — marking it cancelled first would tell a member a charge had stopped while
it had not.

**§17 is complete.** Add-on *purchase* deliberately refuses with `409` rather than being unbuilt:
Agent Ops and Chargeback Assist are Phase F and do not exist, and selling a $29/mo subscription to
a product nobody can use is the fabricated-success rule with a card behind it. The billing path for
them is already there the day they ship.

**Still planned:** Stripe Tax, shopper auth mail via Supabase's Send Email Hook, and abandoned-cart
mail — all three confirmed absent 2026-08-10, not merely unlisted. Everything in §10–15 and §19–21
is untouched.

**Authorization on the v1 REST surface was closed 2026-08-11.** `orgHandler` authorizes **every
role** when `permission` is omitted — there is no default — and the §1–8 write routes predate roles,
so `viewer` could edit the catalog, delete storefronts, and change the **x402 payout address**
(`PATCH /api/sites/:id` wrote `walletAddress`, which is `payTo` at checkout). That reopened through
a second route the same hole `PUT /api/integrations/:provider` had been converted to actions to
close. Every mutating route now passes a permission; only `actions/[id]` and
`integrations/[provider]` may omit one, because they delegate to `invokeAction`. `walletAddress` is
refused **by name** on the site routes and moves only through `payments.connectRail` (D-entry in
`docs/DECISIONS.md`).

**Custom storefront domains are verified as of 2026-08-14, and that closed the same shape of hole
one more time.** `sites.customDomain` was free text any `cms.write` role could write, and `proxy.ts`
routes on it — so an org could claim a hostname it did not own and answer for it the moment that
host pointed here. There was no uniqueness either, so two sites holding one hostname was decided by
whichever row the planner returned. Ownership is now a DNS **TXT** nonce at `_markii-verify.{domain}`
(`lib/domains/`), the field is refused **by name** on both site routes, and it moves only through
`domains.connect` / `verify` / `disconnect`. **Only a `verified` row resolves**, and the exclusivity
index is **partial** so a pending claim cannot lock the real owner out — only proof is exclusive.
**Ownership gates, pointing does not**: the CNAME/A record is reported (`pointsToMarkii`), never
required, because it propagates on its own schedule. Nothing ever un-verifies — a failed DNS read is
recorded, not applied, or a resolver blip would take a live store offline. `storefrontUrl` ignores an
unverified domain for the same reason it ignores nothing else: it feeds order email, `llms.txt`, and
every JSON-LD `url`.

**Serving a custom domain is two steps and both are built.** Verifying proves ownership, which makes
Markii willing to route the host. **Registering** (`lib/domains/platform.ts`) attaches it to the
Vercel project, which is what makes the request arrive at all — Vercel rejects an unregistered
hostname at its edge, before `proxy.ts` runs, and issues no TLS certificate. Registration is a
**post-commit effect of `domains.verify`**, re-attempted on every verify so "Check DNS" is also the
repair path; `domains.disconnect` detaches. **Ordering is a security property**: registering on
*claim* would let anyone add any hostname to Markii's Vercel project on a form submission.

**Storefronts' own `{slug}.{ROOT_DOMAIN}` addresses are registered the same way**, because a
wildcard domain on Vercel needs a wildcard certificate, which needs DNS-01, which needs Vercel to
serve the whole zone — and `markii.shop` carries Microsoft 365 mail, Resend DKIM, SPF and DMARC, so
that is a migration rather than a toggle. A `*` CNAME at the registrar handles *resolution*;
per-host registration gets the certificate. Attached on **going live** (not create — a draft would
spend a project domain slot for nothing), moved on slug change, released on delete, kept through a
pause. **The accepted ceiling is one project domain per live storefront**, which is right now and
wrong at a few hundred merchants.

**Three paths drop a verified domain and all three must detach it** — `domains.disconnect`,
`domains.connect` replacing one, and `DELETE /api/sites/:id`. The latter two were leaks when
registration first landed: each stops the row naming the hostname, so nothing afterwards could ever
release it and the domain stayed bound to Markii's Vercel project — consuming its allowance and
blocking the merchant from using that hostname anywhere else. `unregisterDomain` additionally
refuses a platform host outright, because the operation is an irreversible DELETE against the
project that serves every merchant.

`VERCEL_TOKEN` + `VERCEL_PROJECT_ID` gate it, and **unset, a verified domain still does not serve** —
the API reports `platform.configured: false` rather than calling the domain working. So the status
surface now carries **three** facts that fail independently — ownership (merchant), pointing
(merchant), platform (Markii) — and they are never merged into one tick.

**Migration 0031 is applied and the path is verified end to end** —
`tests/integration/domains.test.ts`, 13 tests, including a real DNS lookup that finds nothing, a
second org holding a pending claim on the same hostname, and a `23505` raised by Postgres when a
second row tries to verify one. The `storefrontUrl` gate was **falsified deliberately**: removing it
fails the suite, which is the check this repo's own history says to make before trusting a green run.

**The test that should have caught it was passing for the wrong reason**, which is the more useful
lesson: the integration `Client` replaced its whole cookie jar on every `Set-Cookie`, so after
`POST /api/org/switch` the auth cookies were dropped and everything 401'd — and `refused()` accepts
any 4xx. **A refusal test must assert the session is live first and pin the exact status.**

**A route-vs-service sweep on 2026-08-10 found four live endpoints with no typed client** — digital
delivery in full (`/api/digital-assets` plus every `delivery.*` action), and the discount, tax, and
inventory-level previews. Services now exist (`lib/api/delivery.ts`, plus additions to `commerce.ts`
and `tax-shipping.ts`); **screens still do not**. Digital delivery is the serious one: D5 names
digital-goods sellers as the beachhead, and until a screen lands they cannot upload the files they
sell. The remaining `*_API_LIVE: false` constants (`ACTIONS_UNDO`, `ORG_AUDIT`, `ORG_SESSIONS`) were
checked and are correct — no route backs any of them.

**Recurring membership billing came off this list** on 2026-08-10: it was listed as planned while
being built and passing, which is the same staleness that had MFA's screens listed as missing after
they shipped. **Before trusting any "not built" claim in these docs, check.** The failure mode is
one-directional and consistent — work lands and the doc does not move — so a "planned" item may be
finished, while a "built" item has generally earned it.

**Deferred until further notice — do not build, and do not let schema anticipate it:** **gift
cards** (D33, 2026-08-03) and **merchant email marketing campaigns** (D43, 2026-08-15).

Campaigns sharpen D27 from "not at launch" into a standing deferral: no broadcast sending, list
management, segmentation, or campaign analytics. **Transactional merchant mail is unaffected** —
§24 keeps sending from the merchant's own verified domain, and ESP-as-a-Channel stays the answer for
merchants who need campaigns now. The prerequisite that decides the shape when it does arrive is
**reputation isolation**: SES suspends on *account-wide* bounce and complaint rates, so one merchant
blasting a stale list would take down every merchant's order confirmations. Campaigns cannot share
the transactional sending path — they need dedicated IPs or per-merchant sub-accounts first.

 The metering exclusion in `docs/PRICING.md` §4.1 is asserted but
unimplemented, so a naive implementation mis-bills merchants in one direction or the other —
`lib/commerce/orders.ts` carries the detail. **This got sharper now that threshold fees are actually
invoiced:** while gift cards do not exist the metering base is not wrong, but the day they ship
without their own tender term, that stops being a wrong *measurement* and becomes a wrong *charge*
on a real invoice. Implement the exclusion in the same change as gift cards, not after.

**What remains is gated by work, not by credentials.** `STRIPE_SECRET_KEY` exists and both the card
rail and subscription billing are written on top of it. The plan Prices are **provisioned by
`pnpm stripe:prices --apply`** rather than by hand: it derives every amount from `lib/plans.ts`
through `lib/billing/price-catalog.ts` — the same module `resolvePrice` verifies against — so the
creator and the verifier cannot disagree. It refuses a live key (plan prices are still PROPOSED),
reports a mismatched Price instead of editing it (Stripe amounts are immutable, so a "fix" would
change what existing subscribers pay), and is idempotent. **The six test-mode Prices exist as of
2026-08-10.** The trap it removes: `docs/PRICING.md` quotes annual plans *per month*, so a
hand-created `markii_starter_year` at `1500` instead of `18000` underbills by 12× and looks right in
the dashboard.

**The threshold fee has now reached a real Stripe invoice** —
`tests/integration/stripe-fee-invoice.test.ts` (opt-in, `MARKII_STRIPE_TESTS=1`) creates a real
subscription and asserts the fee line's amount, currency, and description **against Stripe**, not
against the response that raised it. Until then every test org lacked a subscription, so
`assessmentBillable` refused before Stripe was ever called and the boundary itself was unproven.
**AWS SES cleared the same boundary on 2026-08-11** — credentials, sandbox escape, and a live send
are done; a merchant's own verified domain is the only gate left, and that one is theirs to pass.
Everything refuses rather than stubs — see the `configuration_required` pattern in
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
  `{slug}.localhost`, **verified** custom domains → `/_sites/[slug]`). Resolution and its cache live
  in `lib/domains/index.ts`, which **must never import `node:dns`** — it is in the proxy bundle; the
  verification lookups are in `lib/domains/verification.ts`, which the proxy never touches
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
- **MFA is mandatory for merchants and never for shoppers** (D40, ✅ **built** 2026-08-08; the
  screens too, verified 2026-08-10 — `/mfa` routes to enrol/challenge/recover from the live gate,
  and `MfaStepUpProvider` in the dashboard layout turns a `403 MFA_REQUIRED` into a modal rather
  than a lost page). Every staff account enrols TOTP and is challenged to `aal2` at every sign-in.
  **Enforcement lives in `getSession()`**, not in `requireSession` or `requireAuthContext` — both are
  real entry points, and guarding only the second left `/api/me` serving unenrolled merchants until
  the tests caught it. It answers **`403 MFA_REQUIRED`, never `401`**: the caller is authenticated,
  and a 401 loops them through a sign-in that cannot help. **API tokens are exempt** — a scoped token
  is its own credential, revoked rather than re-authenticated. Shoppers are excluded on `user_kind`;
  guest checkout would make shopper MFA bypassable anyway. **Recovery codes** (`lib/auth/
  recovery-codes.ts`) are what make it shippable: Supabase ships TOTP and no backup codes, so without
  them a lost phone means a lost store.
- **Step-up: a fresh factor within 15 minutes before anything that moves money or grants access.**
  `requiresStepUp` sits beside `riskTier` in the registry and is enforced in `invokeAction`, so one
  check covers UI, HTTP API, agents, and MCP — **an agent cannot route around it**, which is the
  whole reason the registry exists. It reads the **AMR timestamp, not `aal2`**: a session that
  cleared MFA this morning is still `aal2` tonight. Skipped on dry runs so a proposal renders before
  the challenge. **Converting the integrations route to actions to hang this on found a live
  privilege hole** — `PUT /api/integrations/:provider` had *no permission check at all*, so any
  staff member including `viewer` could change the x402 wallet address, which is the payout
  destination. Both holes existed because the route mutated outside the registry.
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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
