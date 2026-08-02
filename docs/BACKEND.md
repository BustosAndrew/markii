# Backend — Start Here

**You own `/api/*`, the database, auth, billing, payments, and email.** The frontend owns every
screen and calls only what `docs/API.md` marks ✅ LIVE. This document is the entry point: what
exists, what to build, in what order, and the traps that will otherwise cost weeks.

## Read in this order

1. **This file** — scope and build order
2. `CLAUDE.md` — working rules (binding)
3. `docs/API.md` — the contract you are implementing. **You own keeping it accurate**
4. `docs/DECISIONS.md` — every settled decision with reasoning. Check before re-arguing anything
5. `docs/PRICING.md` §4 — the threshold fee engine, before touching billing

---

## What already exists

Real and working (`docs/API.md` §1–8): Drizzle schema in `lib/db/`, every route under `app/api/*`,
the storefront renderer in `app/%5Fsites/[site]/`, host routing in `proxy.ts`, x402 checkout,
the Shopify/Woo/CSV importer, generators for `llms.txt` / `agent.md` / JSON-LD, and a seed script.

```
lib/db/          schema.ts · index.ts
lib/             queries.ts · validation.ts · api.ts · importer.ts · x402.ts
                 generators.ts · storefront.ts · integrations.ts · agents.ts
app/api/         sites · products · categories · import · analytics · finances
                 orders · integrations · uploads · preview · template · overview
```

**Both structural gaps are now closed.** Auth and tenancy landed in Phase A (`lib/auth/`,
`lib/tenancy.ts`, the action registry in `lib/actions/`). The cart and checkout layer landed in
§18.4 — `lib/commerce/{cart,pricing,reservations,orders}.ts` plus the storefront routes — so the
human path and the x402 agent path now share one order pipeline and one metering event.

Commerce core is now complete end to end: `lib/commerce/{cart,pricing,discounts,shipping,tax,
reservations,allocation,refunds,orders}.ts`. A physical-goods store checks out once its merchant has
configured a shipping zone and rate; an unconfigured one is refused rather than quoted a zero
shipping cost it would silently absorb.

**§18.7 order operations landed.** Orders are itemised (`order_lines`, frozen from the checkout
session's `lineSnapshot`), and `orders.refund` / `cancel` / `fulfill` / `addNote` /
`resendConfirmation` are registry actions. Refunds are partial or full, restock to the location the
stock left from, and meter **net sales** — see below. Fulfillment is manual and explicitly
unverified; Markii does no fulfillment logistics.

**§18.8 digital delivery landed** — the D5 beachhead, and with it Supabase Storage
(`lib/storage/`, §0 task 8). A paid order issues `download_grants` inside the completion
transaction; `/_sites/:site/download/:token` authorises, meters, and **302s to a five-minute signed
URL** rather than serving bytes, because G5 forbids proxying. Licence keys come from a
merchant-supplied pool — Markii never generates one — and a refund revokes the downloads and
returns the keys. Storage and egress are metered against G5's quotas and reported as
`advisoryOnly`, since those numbers are not signed off and blocking a merchant's customers on an
unagreed figure is worse than not gating yet.

**What is still missing** is the card rail (`lib/payments/` reports `configuration_required`; no
`STRIPE_SECRET_KEY` exists yet), Stripe Tax, gift cards, **processor-executed refunds** —
`orders.refund` records a refund the merchant issued and refuses `method: "processor"` with the
reason, since Stripe is unwired and x402 settlement is irreversible — and **membership gating**,
which has no content model to gate until Phase D.

**Storage buckets are not in the migration chain.** Supabase creates them through its Storage API,
not DDL, so a fresh environment has none and uploads fail until `pnpm storage:init` runs. It is
idempotent, and it fails loudly if `digital-assets` is ever public — which would make every download
limit in §18.8 decoration.

**The metering rule refunds are built on:** the `UsageRecord` meters **net sales**
(`subtotal − discounts`), never the order total, because `docs/PRICING.md` §4.1 excludes tax and
shipping. Metering the total would bill a merchant against tax they collected for a government and
postage they passed through — worst for whoever ships the most. A refund is its own record with a
negative amount, computed the same way, keyed `refund:{refundId}` and stamped with the environment
**read from the sale** rather than re-derived.

---

## Scope for launch

Launch is a subset (`docs/DECISIONS.md` §G10 — two people, ~4–6 months):

**In:** Supabase migration · **A** auth, orgs, staff, roles · **B** plans, billing, metering,
threshold fees · **C** variants, inventory, collections, customers, cart, human checkout, discounts,
tax, shipping rates, orders, refunds, **digital delivery** · rule-based readiness computation ·
email plumbing (SES + Resend).

**Out — do not build:** the site builder and CMS node model, MCP server, Channels, Agent Test Lab,
the analytics event model beyond crawls, Chargeback Assist, Agent Ops chat, native email campaigns,
fulfillment logistics, POS.

---

## Build order

### 0. Supabase migration — do this first

Before anything else, while there is no production data. Schema is unchanged (both are Postgres);
this is a driver and services swap. Full task list in `docs/DECISIONS.md` §"Data architecture".

> **Progress (2026-07-30) — the code half is done; the provisioning half is not.**
>
> ✅ Driver swapped to `postgres.js` / `drizzle-orm/postgres-js` (`lib/db/index.ts`), with
> `prepare: false` — mandatory on the transaction pooler — and a per-process pool.
> ✅ `DATABASE_URL` (6543) vs `DIRECT_URL` (5432) split, with `drizzle.config.ts` refusing to
> migrate over the pooler.
> ✅ Migrations moved to `drizzle-kit generate`: `0000_init` (baseline, **includes `sites.themeId`**,
> so a fresh database no longer needs the outstanding D29 `db:push`) and `0001_action_invocations`.
> Both end with hand-authored **RLS deny-by-default**. `pnpm db:generate` / `db:migrate` added.
> ✅ Proxy custom-domain lookup cached in `lib/domains.ts`, with negative caching and invalidation
> on site create/update/delete — no more database query per storefront request.
> ✅ Seed script closes its connection; `.env.example` rewritten to match what the code reads.
>
> ✅ **Task 8 done — uploads are on Supabase Storage** (`lib/storage/`). Two buckets: `public-media`
> for product images, private `digital-assets` for files merchants sell. The Vercel Blob and
> local-filesystem paths are gone; the filesystem fallback silently broke every deployment, since
> Vercel's filesystem is ephemeral. Buckets are provisioned by `pnpm storage:init`, **not** by the
> migration chain — Supabase creates them through its Storage API, not DDL.
>
> ⏳ **Still needing credentials, not code:** SMTP config, regenerating seed data against the hosted
> project, and dropping the Neon project.
>
> ⚠️ **Edge Config was not used.** `lib/domains.ts` caches in-process with a 5-minute TTL, which
> removes the per-request query but means an invalidation only clears the instance that served the
> write; other instances correct within one TTL. Moving to Edge Config needs a provisioned store —
> the module is shaped so that becomes a lookup swap, not a rewrite.

Ten tasks in brief: swap `@neondatabase/serverless` → `postgres.js` and `drizzle-orm/neon-http` →
`drizzle-orm/postgres-js` · **transaction pooler (6543) for queries, session mode (5432) for
migrations** (a pooled connection cannot run DDL) · **fix, don't port, the proxy lookup** · update
the seed script · new env vars · move to `drizzle-kit generate` + reviewed SQL · Supabase Auth ·
uploads → Supabase Storage · SMTP config · drop the Neon project.

**One schema change is already outstanding.** `sites.themeId` (D29) landed in `lib/db/schema.ts`
with the theme work, so any database provisioned before it is missing the column — and every sites
query selects all columns, so §2 fails outright until it exists. Apply it as the **last**
`db:push`, then switch to generated migrations.

**Env vars the code already reads but `.env.example` does not list:** `ROOT_DOMAIN` (both
[`proxy.ts`](../proxy.ts) and [`lib/api.ts`](../lib/api.ts) depend on it), plus the ones this phase
adds — `SUPABASE_SERVICE_ROLE_KEY` (server-only, never `NEXT_PUBLIC_*`), a session-mode
`DIRECT_URL` for migrations alongside the pooled `DATABASE_URL`, `STRIPE_WEBHOOK_SECRET`, and the
SES/Resend credentials. Update the example file in the same commit that starts reading each one.

**Fix `proxy.ts` while you are here.** [`proxy.ts:31`](../proxy.ts#L31) runs a blocking SQL query on
**every custom-domain request**, before rendering — a shopper in Singapore pays a trans-Pacific
round trip to resolve a hostname. Move host→slug resolution to Edge Config or KV, written on domain
connect/disconnect. Biggest latency win available, small change.

**Also replace hardcoded domain literals** (`lib/importer.ts`, `components/dashboard/site-card.tsx`,
`create-website-wizard.tsx`, `app/page.tsx`, `websites/[slug]/page.tsx`) with `ROOT_DOMAIN`, now
`markii.shop`.

### 1. The action primitive — earlier than the original plan said

> **Built 2026-07-30** — `lib/actions/` (`registry.ts`, `invoke.ts`, `types.ts`) plus the
> `action_invocations` audit table. Dry run is the real action in a rolled-back transaction;
> `ctx.effect()` defers anything the database cannot undo until after commit; authorization is
> injected via `setAuthorizationResolver` and **denies everything** until Phase A installs the real
> resolver. No action definitions and no `/api/actions*` routes yet — both need an actor, so they
> land with §16. Full status in `docs/API.md` §22.

`docs/BUILDER.md` puts the action registry in Phase D with the site builder. **Build the primitive
now instead.** It is roughly a day of work, and if Phase C's commerce mutations are written as plain
route handlers they all have to be refactored later — exactly the bolt-on failure the agent-native
architecture exists to prevent.

```ts
defineAction({
  id: "catalog.updateProduct",
  description: string,           // written for an agent as much as a human
  input: ZodSchema,              // single source of validation truth
  permission: "catalog.write",   // server-checked, same for every caller
  riskTier: "read" | "low" | "medium" | "high",
  undoable: boolean,
  run(input, ctx): Promise<Result>,
});
```

What waits for Phase D is only the **MCP server** and **builder-specific actions**. The registry
itself, and routing every Phase C mutation through it, starts now. Contract: `docs/API.md` §22.

### 2. Phase A — auth, orgs, tenancy

Supabase Auth, model `Organization → Stores → Staff`, users may belong to several orgs. Contract:
`docs/API.md` §16. Verify the six requirements in `docs/DECISIONS.md` §"Auth — D3" before locking —
**item 4 (isolated staff vs shopper identity domains) is the most likely to bite.**

**This is a breaking change to every existing route.** Do not rely on remembering to add a `where
orgId = …` clause to thirty files — one miss is a cross-tenant data leak.

> **Make the unscoped query impossible to write.** Put org-scoped helpers in `lib/queries.ts` that
> take `orgId` as a required argument and never export an unscoped variant. Structure beats
> discipline; a code review will not reliably catch the one route that forgot.

**You own the auth routes, not just the tenancy model.** Sessions are httpOnly cookies, never
`localStorage`, because merchant custom code runs on storefronts — and **D30 settles what that
requires**: every auth mutation runs server-side in `/api/auth/*` (`docs/API.md` §16) using
`createServerClient`. "Use the SSR package" is *not* sufficient; `@supabase/ssr` also exports
`createBrowserClient`, whose cookies are written by `document.cookie` and therefore **cannot be
`HttpOnly`**. Deliver these four so the frontend never needs a browser-side Supabase client:

1. `POST /api/auth/sign-up` · `sign-in` · `sign-out` · `reset-password` · `update-password`, plus
   `GET /api/auth/callback` for emailed codes. Set cookies with `httpOnly`, `secure`,
   `sameSite: "lax"`.
2. **Wire session refresh into [`proxy.ts`](../proxy.ts).** `lib/supabase/middleware.ts` already has
   `updateSupabaseSession`, written by the frontend and currently imported nowhere — so today
   nothing refreshes a session and nothing guards `/dashboard`. `proxy.ts` is yours; it must do host
   routing *and* session refresh without a DB round trip (see §0).
3. `GET /api/me` in the shape §16 pins — one call, the dashboard's only identity source.
4. Use the **`getAll` / `setAll`** cookie adapter. The `get`/`set`/`remove` triple that
   `lib/supabase/` currently uses is deprecated in `@supabase/ssr` ≥ 0.10 and drops chunked-cookie
   handling, which large sessions need.

Delete `lib/supabase/client.ts` as part of this. A browser client in the tree is how this decision
gets quietly reversed later.

### 3. Phase B — billing and metering

Contract `docs/API.md` §17; the fee engine is specified in `docs/PRICING.md` §4. Stripe Billing for
subscriptions, **Connect Standard** for merchant payments (D4).

**Build the metering ledger before commerce launches, not after.** Retrofitting a fee ledger over
historical orders is lossy and painful.

- **Usage records are immutable and written at event time** — one row per sale, refund, and lost
  chargeback. **Never compute fees from a live join over `orders`**: orders mutate, ledgers must not.
- Store both original and billing-currency amounts **with the FX rate used**. Never retro-recompute.
- **Test-mode orders never count** — enforce at write time, not by filtering at read time.
- **Idempotency keys on every write.** Stripe webhooks retry; double-counted revenue is a billing
  dispute with a merchant.
- Nightly rollup for the live meter; **authoritative recompute from records at period close**, with
  an alert on drift between the two.
- The marginal formula in §4.3 — only the slice above the threshold is billable. Round half-even.

**Stripe webhooks:** verify signatures, handle retries idempotently, and note that Connect sends
events for connected accounts as well as the platform — route them separately.

### 4. Phase C — commerce core

Contract `docs/API.md` §18. The largest phase. Order within it:

1. ~~**Variants and options**~~ — done
2. ~~**Inventory as an append-only ledger**~~ — done
3. ~~**Collections** (manual + rule-based), **customers**~~ — done
4. ~~**Cart and checkout**~~ — done for the x402 rail; card rail waits on Stripe credentials
5. ~~**Discounts**, tax, shipping rates~~ — done. Stripe Tax and gift cards still open
6. ~~**Orders**: refunds, cancellations, manual fulfillment status, timeline~~ — done. Executing a
   refund on a rail (rather than recording one) waits on Stripe credentials
7. ~~**Digital delivery** — signed expiring URLs, download limits, licence keys~~ — done.
   **Membership and content gating are not started**: the content model they gate is Phase D and
   recurring access needs Phase B billing, so neither is startable yet

**Checkout rules that are not negotiable:**

- **Recompute prices, discounts, tax, and totals server-side.** Never trust client-supplied amounts.
- **Reserve inventory at payment authorization**, release on expiry or failure. Concurrent checkout
  of the last unit is a real race — solve it with a database transaction or constraint, not an
  application-level read-then-write.
- Card data goes only to Stripe-hosted elements (PCI SAQ-A).
- **Write the usage record** (§3) on order completion — both for card checkout *and* the existing
  x402 path, which must flow into the same order pipeline.

**Digital delivery matters more than usual** — it is the beachhead (D5). Serve files with **signed,
expiring URLs directly from Supabase Storage, never proxied through a route handler**: proxying pays
bandwidth twice and risks function timeouts on large files. Signed URLs also give download-limit
enforcement for free. Meter storage and egress per org against the G5 quotas.

### 5. ~~Readiness computation~~ — done

Rule-based and deterministic — **no model inference**. `docs/PRICING.md` §"Margin check" makes this
a cost constraint, not just a preference: per-product inference on every plan would exceed every
other infrastructure line combined. Scores derive from real catalog data; contract `docs/API.md` §9.

> **Built.** `lib/readiness/` — `rules.ts` (pure findings), `score.ts` (pure arithmetic),
> `compute.ts` (loads facts, merges decisions, snapshots). Routes: overview, issues, issues/:id,
> export, history, products matrix. Triage is the `readiness.updateIssues` action.
>
> Three decisions worth not re-arguing:
>
> - **Issues are recomputed per request, never stored.** A stored issue goes stale the moment
>   someone edits a product. Only merchant *decisions* persist, keyed by an issue id derived
>   deterministically from the rule and its subject — that determinism is what makes a dismissal
>   survive the next recomputation.
> - **Scoring is per subject, then averaged.** Each product and store loses points for its own
>   issues; a component is the mean. A flat per-component penalty floors at zero and stops moving,
>   so a merchant with fifty broken products would see no change after fixing forty-five.
> - **A rule may only check a field the platform offers.** The §11 agent-data extension is Phase E
>   and does not exist, so nothing scores a merchant on it — that would be a fabricated criticism.
>   Those groups are reported in `notMeasured` with the reason.

### 6. Email plumbing

`lib/email/` exposing `sendPlatformMail()` (→ Resend, `markii.shop`) and `sendMerchantMail()`
(→ SES, the merchant's verified domain). Callers pick the **stream**, never the provider.

- Merchant mail requires a **verified sending domain to go live** — blocking item on the publish
  checklist. Test mode may send from Markii's domain, labeled.
- Shopper auth mail goes through Supabase's **Send Email Hook** → your handler → SES, reading
  `store_id` from user metadata to pick the sender. Supabase's built-in SMTP allows only one
  from-address per project, which is why the hook is required.
- Secure Email Change requires sending **two** emails with specific token/hash pairings.
- SES sandbox escape needs AWS approval — **start that early**, it is not instant.

---

## Rules that will otherwise be broken

**Actions are the only mutation path.** No route handler mutates state outside the registry —
otherwise the UI and agents drift apart, which is the failure this design exists to prevent.

**Authorization lives in the action registry, never Postgres RLS.** But **enable RLS deny-by-default
on every table anyway** — it costs nothing and means a leaked anon key exposes nothing. Do not drift
into RLS-based authorization: two authorization systems that disagree is worse than either alone.
**The service-role key must never reach the browser** — server-side only, never `NEXT_PUBLIC_*`.

**Money:** integer minor units, explicit currency, no float maths. New fields take a `Minor` suffix;
the older `Cents` fields in §1–8 stay as they are.

**Never hold merchant funds** and never take an `application_fee_amount`. Markii's fee bills on its
own invoice; the merchant's payment flow is untouched. This is a licensing boundary, not a
preference.

**`db:push` stops being safe** once real merchants exist — `drizzle-kit generate` plus reviewed SQL.

**Keep `docs/API.md` accurate.** The frontend builds against it and cannot see your code. If a shape
changes, update the contract in the same commit and move the section's status badge when a route
goes live — that badge is the frontend's only signal that something is callable.

---

## Definition of done

- Routed through `defineAction` with a zod schema and a server-checked permission
- Org-scoped via the required-`orgId` query helpers — no unscoped query exists
- Idempotent where it can be retried; transactional where it touches money or stock
- Money in integer minor units with explicit currency
- Usage record written for anything that affects billable volume, on the **net
  sales** base (`subtotal − discounts`), never the order total (D36)
- Errors follow the `{ error: { code, message } }` envelope in `docs/API.md`
- `docs/API.md` updated: shape accurate, status badge moved to ✅ LIVE
- **Tested**: pure money and rule logic gets a unit test in `lib/**/*.test.ts`;
  anything that spans a route, the database, and a response gets an integration
  test in `tests/integration/`. Every bug found in Phase C lived in that span,
  not in the arithmetic — see `tests/README.md`
- `pnpm build`, `pnpm lint`, and `pnpm test` pass; `pnpm test:integration` passes
  before calling a commerce change done

---

## Traps worth knowing in advance

| Trap | Cost if missed |
|---|---|
| Forgetting an org filter on one route | Cross-tenant data leak |
| Any auth mutation running in the browser | The session cookie cannot be `HttpOnly` (D30) — XSS in merchant custom code reaches an admin session |
| Computing fees from `orders` instead of usage records | Wrong invoices after any refund |
| Non-idempotent webhook handling | Double-charged merchants |
| Read-then-write inventory checks | Overselling the last unit |
| Proxying large file downloads | Double bandwidth cost, function timeouts |
| Service-role key in a `NEXT_PUBLIC_*` var | Full database compromise |
| Skipping the action registry in Phase C | Full refactor when Phase D lands |
| Test-mode orders reaching production totals | Merchant trust, immediately |
