# Markii — Build Plan (v3: commerce platform)

Markii is a **commerce platform** — the Shopify/Squarespace category — with two things those
platforms don't have: storefronts that are natively legible to AI agents, and pricing that doesn't
tax growth until a merchant is genuinely big.

**The pitch:** everything Shopify does (except fulfillment logistics, for now), at a lower monthly
price, with **no Markii transaction fee until a merchant crosses an annual sales threshold** — and
a store that AI agents can read, recommend, and buy from out of the box.

## Direction history

| Version | Product | Status |
|---|---|---|
| v1 | Agent-readable storefront generator + x402 checkout | **built** — carries forward |
| v2 | Merchant control plane for AI commerce (readiness, channels, test lab) | **specced** — becomes the differentiator layer, not the whole product |
| **v3** | **Full commerce platform** with visual site builder, own monetization, and the v1+v2 AI layer on top | **this document** |

Nothing from v1/v2 is discarded. The AI-legibility work stops being the product and becomes the
reason to choose this platform over the incumbents.

---

## 1. What this changes

The v2 plan assumed the merchant already had a catalog and sold elsewhere. v3 says Markii **is**
where they sell. That adds four things the product does not have at all:

1. **Human commerce.** Cart, checkout, customers, discounts, taxes, shipping rates. Today the only
   checkout path is agent-driven x402 — a store real shoppers can't buy from is not a commerce
   platform.
2. **An agent-native site builder.** Drag-and-drop block editing (Stacks/Webflow model) with custom
   code access, built so humans and AI agents edit the same site through the same actions,
   permissions, and audit trail — including a first-class MCP server. See `docs/BUILDER.md`.
3. **Monetization.** Subscription plans plus a threshold-based transaction fee. See
   `docs/PRICING.md`.
4. **Accounts and auth (confirmed requirement).** Real merchant sign-up, sign-in, sessions, MFA,
   organizations, staff, and roles. Currently **none exists** — every route is open and
   single-tenant. Billing, multi-merchant tenancy, scoped agent access, and the MCP surface all
   depend on it. This is the first blocking dependency; specifics in `docs/API.md` §16.

It also creates two hard constraints worth naming up front:

- **The site builder must not break agent legibility.** A Webflow-style canvas emitting nested
  `<div>` soup would destroy the one thing that differentiates this platform. The builder renders
  semantic SSR HTML from a typed node tree and contributes JSON-LD automatically.
- **The platform is agent-native, not agent-compatible.** Every capability in the admin is defined
  once as an *action* that serves the UI, the HTTP API, agent tools, and MCP simultaneously — so an
  agent can do anything a human can, under the same permissions and audit trail. This cannot be
  bolted on later, which is why the **registry primitive lands in Phase C** with the first commerce
  mutations — not in Phase D with the builder, and certainly not in Phase F with the chat product
  (`docs/API.md` §22, `docs/BACKEND.md` §1).

Two distinct agent audiences follow from this, and both matter: **agents that shop the storefront**
and **agents that build and operate the store**.

## 2. Product surface map

### 2.1 Carried forward (built)
Multi-tenant storefront renderer, `llms.txt` / `agent.md` / `sitemap.xml` / JSON-LD generators,
host routing, catalog importer (Shopify/Woo/CSV), x402 checkout, dashboard CRUD for
sites/products/categories, analytics on crawl traffic, integrations shell.

### 2.2 Specced, not built (v2 AI layer)
Agent Readiness Score, Catalog Health, Channels, Agent Test Lab, analytics funnel, orders detail.
Contracts live in `docs/API.md` §9–15. These stay planned and land in Phase D.

### 2.3 New in v3

| Domain | Scope |
|---|---|
| **Accounts** | Auth, organizations, stores-per-org, staff invites, roles, sessions, audit log |
| **Billing** | Plans, subscriptions, trials, proration, invoices, dunning, GMV metering, threshold fee engine, add-on entitlements |
| **Catalog (deepened)** | Variants & option matrix, inventory per location, collections (manual + rule-based), compare-at/cost price, media library, bulk edit |
| **Selling** | Cart, sessions, human checkout, payment rails (Stripe/PayPal/card/x402), discounts, gift cards, abandoned cart |
| **Customers** | Accounts, addresses, order history, consent, segments, customer notes |
| **Tax & shipping** | Tax provider integration, rate zones/methods used *at checkout* (rate config, not logistics) |
| **Orders (deepened)** | Refunds, cancellations, edits, notes, manual fulfillment status, timeline |
| **Site builder** | Block editor, component registry, themes, templates, custom code, versioning, publish |
| **Content** | Pages, blog, navigation menus, SEO fields, redirects, forms |
| **Disputes** | Chargeback visibility (included) + assisted response (add-on) — see §6 |
| **Agent Ops** | Chat-driven operations assistant add-on — **built last**, see `docs/AGENT-OPS.md` |

## 3. Explicitly out of scope

Two kinds of "no" appear below and they are not the same. **Deliberate no** — POS, chargeback
guarantees, custodial funds — means there is no intent to build it and nothing should be designed in
anticipation of it. **Deferred** means planned or plausible later, so the architecture should avoid
foreclosing it.

- **Fulfillment logistics.** No carrier rate shopping, label purchase, pick/pack, warehouse or 3PL
  integration, or returns logistics. *In scope:* manual fulfillment status, tracking number entry,
  and shipping **rates configured by the merchant** for checkout math — you cannot take an order
  without quoting shipping. Revisit post-launch.
- **Chargeback guarantees.** Dispute *handling* may be an add-on; reimbursing merchant losses is an
  insurance product with underwriting and regulatory obligations. Not offered. See §6.
- **Native marketing email / campaigns.** Shopify includes 10,000 free emails per month on every
  plan — affordable to them because payment-processing margin funds it, and Markii has deliberately
  given that margin up. Transactional mail and free abandoned-cart are in scope; campaigns are
  handled by **integrating Klaviyo/Omnisend/Mailchimp as Channels**, with native campaigns only as a
  possible later add-on (`docs/DECISIONS.md` §D27).
- **POS / in-person retail — not offered, and not on the roadmap** (owner, 2026-07-29). This is a
  deliberate no, not a deferral: POS means hardware, card-present certification, offline sync, and a
  retail support model — a different company. Revisit only if the market forces it, and not for a
  long while. Do not design "for POS later"; do not let it shape the data model.
- **B2B/wholesale price lists**, **subscriptions-as-a-product**, **multi-language storefronts**,
  **a third-party app marketplace** — deferred, plausible post-launch.
- **The EU at launch** — deferred by weeks, not quarters. US, Canada, UK, and Australia first, with
  UK acting as a single-jurisdiction rehearsal for the same VAT mechanics. The EU is easier than it
  looks: the **merchant is the seller of record** under Connect Standard, so Markii is not the
  taxpayer, and Stripe Tax already handles rates, location evidence, VAT ID validation, reverse
  charge, and OSS threshold monitoring. The real gates are support load and a legal check on
  deemed-supplier status (`docs/DECISIONS.md` §G2).
- **A published uptime SLA.** Status page, PITR backups, and internal RTO/RPO targets at launch; a
  contractual SLA only with a later enterprise tier, once there is history to base it on (§G8).
- **Custodial funds.** Payouts settle through the merchant's own processor account (Stripe Connect
  or direct). Markii does not hold merchant money; that would trigger money-transmission licensing.

## 4. Architecture implications

**Auth & tenancy (confirmed, blocking).** Model is `Organization → Stores → Staff`, with users able
to belong to several orgs (agencies). Markii already supports multiple sites per install, a genuine
edge over Shopify's one-store-per-account — keep it and make store count a plan lever. **Provider:
Supabase Auth** (decided 2026-07-29), so users live in Markii's own Postgres and staff records join
directly against orgs, stores, and audit rows. Six requirements must be verified before Phase A
locks — httpOnly cookie sessions (use the SSR integration, not the browser client), multi-org
membership, MFA, isolated staff/customer identity domains, SSO headroom, machine tokens
(`docs/DECISIONS.md` §D3). Sessions are
httpOnly cookies, never `localStorage` — merchant custom code runs on storefronts, and XSS there
must never reach an admin session. Storefront **customer** accounts are a separate identity domain
that shares nothing with staff auth. Every existing `/api/*` route becomes org-scoped: a breaking
change to the current open API that must land before any public exposure.

**Action layer (agent-native core).** One `defineAction` registry backs the UI, HTTP API, agent
tools, MCP server, and CLI. Actions carry a zod input schema, a server-checked permission, a risk
tier, and an undo inverse. `dry-run` produces the diff that becomes an agent proposal — there is no
second proposal engine, and no privileged agent path around validation (`docs/API.md` §22).

**The registry primitive is built in Phase C, not D** (revised 2026-07-29). It is about a day of
work, and routing Phase C's commerce mutations through it from the start avoids refactoring every
one of them later — which would be precisely the bolt-on failure agent-native architecture exists to
prevent. Phase D adds the builder's actions and the MCP server on top of a registry already in
production use.

**Payments & PCI.** Stripe-hosted elements/Checkout so card data never touches Markii servers
(SAQ-A scope). Merchants connect via **Connect Standard** (D4): they keep their own Stripe account,
rates, dashboard, and payouts, and Markii stores a revocable token rather than a secret key.
Markii takes **no `application_fee_amount`** — subscription and threshold fees bill on Markii's own
invoice, never skimmed from the payment flow.

**Markii does not negotiate processing rates on merchants' behalf.** That would require volume
leverage Markii will not have for years, invert dispute and negative-balance liability onto the
platform, and reopen the money-transmission exposure §3 avoids — for zero margin under a 0% platform
fee. It is also a smaller benefit than it appears: below ~$1M/yr a merchant gets Stripe's standard
rate regardless. The differentiator is **no platform fee on top of the rate**, not a better rate.

x402/USDC remains a peer rail; on-chain settlement is **irreversible** and has no chargeback path, a
real merchant-facing difference to document, not hide.

**Storefront runtime.** Still server-rendered. The builder's output is a versioned JSON node tree
compiled to semantic HTML at render time — the editor runtime never ships to the storefront. Cart
and checkout introduce the first legitimate client interactivity on `_sites/`; it must be scoped to
islands (cart drawer, variant picker, checkout) and stay off content and product pages.

**Data model growth.** Variants, inventory levels, carts, customers, discounts, disputes,
subscriptions, usage records, page trees, and revisions. Plan a proper migration workflow
(`drizzle-kit generate` + reviewed SQL) — `db:push` is no longer safe once real merchant data
exists.

**Database, auth, and file storage: Supabase** (decided 2026-07-29, replacing Neon — ~2.6× cheaper
compute, ~2.8× cheaper storage, and it absorbs auth and blob storage into one bill). The schema is
unchanged: both are Postgres and Drizzle supports each, so this is a driver and services swap.
**Migrate before Phase A**, while there is no production data. Full task list in
`docs/DECISIONS.md` §"Data architecture". One security note that comes with it: authorization stays
in the action registry, **not** Postgres RLS — but enable RLS deny-by-default on every table anyway,
and never let the service-role key reach the browser.

**Media is metered and gated per plan** — storage *and* egress, because egress is the expensive half
(`docs/DECISIONS.md` §G5). Two architectural rules follow: serve large files with **signed,
expiring URLs directly from Supabase Storage**, never proxied through a Next.js route (proxying pays
bandwidth twice and risks function timeouts — and signed URLs give digital-delivery download limits
for free); and **do not host video** — offer Mux/Vimeo/YouTube embeds, since video bandwidth would
break the cost model fastest.

**Global distribution.** Storefronts serve shoppers and agents worldwide from a single-primary
Postgres, which raises a fair question about whether that is the right system of record. It is —
global latency here is a **caching** problem, not a database problem. Commerce reads are
overwhelmingly cacheable, and money/inventory need strong consistency more than they need
distributed writes.

The one genuine defect today: [`proxy.ts:31`](../proxy.ts#L31) queries Postgres on **every
custom-domain request**, before rendering — so a shopper in Singapore pays a trans-Pacific round
trip to resolve a hostname. Fix by moving host→slug resolution to an edge-replicated store (Vercel
Edge Config or global KV), then cache storefront pages with tag-based invalidation on
publish/price/stock. That leaves the database on the critical path only for cache misses, carts,
checkout, and the dashboard — none of which need multi-region writes. Add read replicas only if
measurement demands it.

Revisit only if a real multi-region *write* requirement appears, which would most likely come from
**data residency** rather than latency — and that is a separate, larger project. Full analysis and
migration task list: `docs/DECISIONS.md` §D6.

**Jobs & webhooks.** Metering rollups, dunning retries, abandoned-cart timers, channel syncs, and
dispute deadline reminders need scheduled + queued execution (Vercel Cron + Queues), plus inbound
webhook handlers for Stripe with idempotency and signature verification.

**Email: two providers, split by whose mail it is.** **AWS SES** carries everything sent *on
merchants' behalf* — order confirmations, shipping and refund notices, digital delivery (download
links, licence keys), abandoned cart, shopper account mail — from each merchant's own verified
domain. **Resend** carries only *Markii's own* mail from `markii.shop`: the marketing-site contact
form, support correspondence, staff auth via Supabase Auth SMTP, invoices, dunning, and platform
notices. Resend never sends merchant mail.

This makes **reputation isolation structural rather than procedural** — a merchant's bad sending
lands on SES and cannot touch Markii's password-reset or billing mail. It also keeps Resend on the
$20/mo Pro tier permanently (the 1,000-domain Scale tier existed only for per-merchant domains) and
cuts email cost at 1,000 merchants from ~$250–350/mo to ~$45/mo.

`lib/email/` exposes `sendPlatformMail()` and `sendMerchantMail()`; callers choose the stream, never
the provider.

**Merchant mail sends from the merchant's own verified domain** — no `noreply@markii.shop` on
customer-facing mail. Test mode may send from Markii's domain, labeled as test, but **a verified
sending domain is a blocking item on the go-live checklist**: a store must not take orders it cannot
confirm. Monitor DKIM/DMARC health per merchant and alert on breakage.

**Shopper account mail** routes through Supabase Auth's **Send Email Hook** rather than its built-in
SMTP, because that SMTP allows only one from-address per project. The hook hands the handler the
user object; `store_id` in user metadata selects the merchant's verified sender, and the mail goes
out via SES. Staff and shoppers live in **separate Supabase projects** — the hard isolation the auth
model requires. Watch shopper MAU cost as a scaling line.

Transactional and marketing mail stay on separate streams with separate consent handling; they carry
different legal obligations.

## 5. Monetization summary

Full spec in **`docs/PRICING.md`**; verified competitor data in **`docs/COMPETITORS.md`**
(checked 2026-07-29).

**What the real market data changed.** The entry price for serious ecommerce is a settled
**$29/mo annual (~$39 monthly)** — Squarespace Core, Wix Core, Shopify Basic, and BigCommerce Core
all sit within a dollar of it. Each attaches a catch: Shopify and BigCommerce charge **up to 2%**
for using a payment provider that isn't theirs (from the first sale, no threshold); Squarespace
charges **5% on digital goods and memberships** until $99/mo; Wix gates ecommerce depth, storage,
and seats. BigCommerce already runs a trailing-12-month GMV threshold, but with low caps
($30K/$100K) that **force a plan upgrade** on crossing.

So the sharpest defensible position is: **bring your own payment provider with no platform fee,
sell digital goods without a cut, get the full feature set on every plan, and never get
force-upgraded** — with a threshold high enough to feel like a milestone and a marginal fee above
it. That attacks Shopify and BigCommerce where they extract money and Squarespace where it hurts
creators, rather than fighting anyone on headline subscription price alone.

The shape:

- **Subscription tiers** (monthly/annual, annual discounted) priced below Shopify and Squarespace
  equivalents. Tiers gate store count, staff seats, and the GMV threshold.
- **Zero Markii transaction fee below the threshold.** Merchants pay only their processor's fees
  (Stripe et al., passed through at cost — never marked up).
- **Above the threshold**, a Markii fee applies **only to the portion above it** (marginal, not a
  cliff), assessed on trailing-12-month net sales.
- **Add-ons**: Agent Ops (chat assistant), Chargeback Assist, extra seats/stores.

Two claims carry obligations: "cheaper than Shopify/Squarespace" must be verified against their
current published pricing before any public comparison and re-checked as they change; and the fee
threshold must be shown to merchants as a live meter with projection, never discovered on an
invoice.

## 6. Chargebacks — recommended stance

Open question from the brief. Recommendation, split three ways:

| Tier | What | Why |
|---|---|---|
| **Included, free** | Dispute inbox: list, reason code, amount, deadline, linked order, evidence checklist | This is surfacing data the merchant's processor already returns. Charging for visibility is hostile and easy to undercut. |
| **Add-on, paid** | Chargeback Assist: auto-assembled evidence packets from order/session/agent-authorization data, deadline reminders, submission, win-rate analytics | Real recurring work, real value, defensible price. |
| **Not offered** | Financial guarantee / loss reimbursement | Insurance-like; needs underwriting, reserves, and licensing. Do not market "protection". |

Agent-originated orders deserve their own dispute handling: x402 settlements can't be charged back
at all, while card orders placed by an agent may face elevated "unauthorized" claims — the evidence
packet should include the agent authorization record from `docs/API.md` §13.

## 7. Delivery phases

### Launch scope first — the phases are not a launch checklist

**Team is two people: one frontend, one backend** (`docs/DECISIONS.md` §G10). Phases A–F in full are
roughly **9–14 months** at that size, which is too long without revenue. So launch on a deliberate
subset and sequence the rest behind it:

**In launch (~4–6 months):** the **Supabase migration** · the **`defineAction` registry primitive** ·
**A** (auth, orgs, roles) · **B** (plans, billing, metering, threshold fees) · **C** (variants,
inventory, cart, human checkout, customers, discounts, tax, orders, digital delivery) · a handful of
**polished themes** on the existing storefront renderer · the **rule-based readiness score**.

**Deferred past launch:** **D** (site builder + action registry) · **E** (Channels, Test Lab, full
analytics funnel) · **F** (Chargeback Assist, then Agent Ops chat).

Two calls worth understanding. **Deferring the builder** is significant — it is the headline feature
— but a creator selling digital products needs a good-looking store far more than a drag-and-drop
canvas, and three or four strong themes cover that while freeing the frontend engineer for the
dashboard surface A/B/C actually require. **Keeping the readiness score** in scope despite it being
Phase E is deliberate: it is cheap (deterministic rules, no inference) and without it Markii launches
as a cheaper Squarespace with no visible differentiator.

The contract-first work is what makes this feasible: `docs/API.md` specifies every endpoint, so
frontend and backend run in parallel rather than in sequence.

### Full phase plan

Each phase is independently shippable. Phase A is blocking for everything.

| Phase | Scope | Exit condition |
|---|---|---|
| **A — Foundations** | Auth (sign-up/in, sessions, MFA), orgs, stores, staff/roles, scoped tokens, org-scoping every API route, migrations workflow, audit log | Multiple real merchants can safely coexist |
| **B — Monetization** | Plans, Stripe Billing subscriptions, trials, invoices, dunning, entitlements, GMV metering, threshold fee engine, billing UI + live threshold meter | Markii can charge money correctly and legibly |
| **C — Commerce core** | Variants, inventory, collections, customers, cart, human checkout, discounts, tax + shipping rates, orders/refunds/manual fulfillment, **digital delivery** (secure/expiring downloads, download limits, licence keys, membership gating) | A real shopper can buy a real product end to end — digital or physical |
| **D — Action layer + site builder** | `defineAction` registry, MCP server, node model, renderer, component registry, editor canvas, style system, custom code, templates, versioning, publish, content/blog/menus/SEO | A merchant builds and publishes a store visually — and an agent can do the same through MCP |
| **E — AI commerce layer** | The v2 plan: readiness score, catalog health, channels, test lab, analytics funnel (`docs/API.md` §9–15) | The differentiator is live on top of a real platform |
| **F — Add-ons** | Chargeback Assist, then **Agent Ops chat (last)** | Ops assistant proposes and executes approved changes safely |

**Sequencing notes.** B before C looks odd but isn't: metering hooks are far cheaper to design into
the order pipeline than to retrofit, and nothing about C is billable without B. D can start in
parallel with C once the node model is agreed — the builder team is not blocked on checkout. E is
mostly specced already and can slot earlier if a demo demands it.

F is last by explicit instruction, and benefits from it: the agent's tools are the action registry
built in D, over APIs that must exist and be stable first. **But note the split** — the *chat
product* is Phase F; the *agent-native architecture* is Phase D. Deferring the architecture would
mean rebuilding the mutation layer later, which is precisely the bolt-on failure mode the
agent-native model exists to avoid.

## 8. Frontend rules (unchanged, still binding)

- Pages call typed services in `lib/api/*`; never `fetch` inline, never `lib/db` from a screen.
- **No mock data or mock route handlers.** Unbacked surfaces show *configuration required* /
  *not yet measured* / *coming soon*.
- Never imply an action happened when it didn't — no fabricated metrics, no success toast for an
  unwired mutation, no test data in production totals.
- Every data surface covers loading, empty, error, partial, and permission states.
- Storefront pages stay server-rendered; client interactivity is islands-only and justified.
- Money is integer minor units end to end. Currency is explicit on every amount. Never do float math
  on money.

## 9. Decisions needed from the owner

Tracked in **`docs/DECISIONS.md`** — that file is the register; this is the summary.

**Blocking (nothing meaningful starts without these):** price points and thresholds (D1) and the
margin check behind them (D2) · auth provider (D3) · **Stripe Connect account type** (D4 — Standard
is required for the "your own Stripe account, your own rates" claim to be true) · beachhead segment
(D5) · data architecture for global distribution (D6).

**Phase-gated:** threshold basis and marginal application · trial and dunning terms · fulfillment
scope · whether Orders ships read-only · cloneability/code export (decide before the theme system
hardens) · concurrent human↔agent edit policy · chargeback stance.

**Unplanned gaps that need a decision before they can be specced:** transactional email provider
(**a commerce platform cannot launch without it**) · launch countries and currencies · sales tax on
Markii's own subscription · support model · media storage limits · storefront search · cookie
consent · SLA and DR commitments · domain and trademark · team capacity · data residency · abuse
and rate limiting.

Also unresolved: the current schema predates organizations — confirm v1 demo data can be reset
rather than migrated.
