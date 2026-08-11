# Markii — Decision Register

Open decisions that gate planning or building. One row per decision, with a recommendation so the
default is never "nobody decided."

**Status:** 🔴 blocking · 🟠 phase-gated · 🔵 gap (not planned anywhere yet) · ✅ resolved

Owner is the person who decides, not the person who implements. Record the answer *in this file*
when it's made, with the date — then update the doc it affects.

---

> **Status as of 2026-07-29: all items resolved.** Nothing blocks the start of build. The tables
> below keep each decision with its reasoning so it can be revisited rather than re-argued; struck
> rows link to the detail section that records the call. New decisions get appended here.

## 🔴 Was blocking — resolved

| ID | Decision | Recommendation | Blocks |
|---|---|---|---|
| ~~D1~~ | ~~Price points, thresholds, fee rates~~ | ⚠️ **SUPERSEDED by D39** (2026-08-06). Was: accepted as proposed (owner, 2026-07-29) — $150k/$750k/$3M at 0.5%/0.4%/0.3% | — |
| ~~D39~~ | ~~Split fee schedule: physical vs digital~~ | ✅ **Owner, 2026-08-06.** Thresholds $1k / $50k / $100k, **applied separately to each class**; above them 1.5%/0.5%/0.25% physical and 3%/1.5%/0.5% digital — §"Split fee schedule — D39" | Replaces D1's single rate |
| ~~D42~~ | ~~Plan prices: proposed → final~~ | ✅ **Owner, 2026-08-10.** $19/$49/$129 monthly and $15/$39/$99 annual-per-month are **signed off and publishable**. `GET /api/billing/plans` now returns `status: "final"`. **Add-on prices stay proposed** — Agent Ops and Chargeback Assist do not exist | Live Stripe Prices still need `pnpm stripe:prices --apply --allow-live` with a live key |
| ~~D2~~ | ~~Margin check~~ | ✅ **Costed 2026-07-29 — D1 holds.** ~92% margin at 1,000 merchants, ~83% at 100. Watch items: media usage (G5), support load (G4) — §"Unit economics — D2" | — |
| ~~D40~~ | ~~MFA scope~~ | ✅ **Owner, 2026-08-07 — ✅ BUILT 2026-08-08.** Mandatory for every merchant; **shoppers excluded**. TOTP + recovery codes + step-up, enforced in `getSession()` and `invokeAction`. §"MFA scope — D40". **Screens built too** (verified 2026-08-10: `/mfa` enrol/challenge/recover + `MfaStepUpProvider`, 16 integration tests) | — |
| ~~D41~~ | ~~Scheduled billing & the `system` actor over HTTP~~ | ✅ **Assistant call, 2026-08-10 — ✅ BUILT.** Vercel Cron → `GET /api/cron/billing`, monthly. Runs the `high`-risk `billing.invoiceAssessments` unattended as a `system` actor; `CRON_SECRET` replaces the "never reachable over HTTP" guarantee — §"Scheduled billing — D41" | Owner may override the §22 rule 3 exception |
| ~~D28~~ | ~~POS / in-person retail~~ | ✅ **Deliberate no, not a deferral** (owner, 2026-07-29). Hardware, card-present certification, offline sync, and a retail support model make it a different company. Do not design for it | — |
| ~~D3~~ | ~~Auth provider~~ | ✅ **Supabase Auth** (owner, 2026-07-29 — superseded Neon Auth when D6 chose Supabase). Same six verifications apply — §"Auth — D3" | — |
| ~~D4~~ | ~~Stripe integration model~~ | ✅ **Connect Standard** (owner, 2026-07-29). Express optional later, never penalized. Direct API keys considered and dropped. **Markii does not negotiate rates on merchants' behalf** — see §D4 | — |
| ~~D5~~ | ~~Beachhead segment~~ | ✅ **Creators & digital-goods / membership sellers** (assistant call, 2026-07-29 — owner may override). See §"Beachhead — D5" | — |
| ~~D27~~ | ~~Marketing email / campaigns~~ | ✅ **Integrate ESPs as Channels; no native campaigns at launch** (owner, 2026-07-29). Abandoned cart ships free. Native campaigns only as a later paid add-on — §"Marketing email — D27" | — |
| ~~D6~~ | ~~Data architecture~~ | ✅ **Supabase** (owner, 2026-07-29) — replaces Neon for database, auth, and file storage. Latency still solved by **caching, not a distributed DB**. Migration plan in §"Data architecture" | — |
| ~~D26~~ | ~~Distribution model~~ | ✅ **Both — open/public source *and* hosted cloud** (owner, 2026-07-29). **Licence still unchosen — see §"Distribution — D26"** | Licence choice blocks any external contribution |


### Cross-tenant tier hole — found and closed 2026-08-11

**Adding membership fields to the product form opened a cross-tenant write.**
`requiresTierId` and `grantsTierId` were added to `productCreateSchema` so the new product form
could set them. Before that, zod stripped them silently, so nothing validated them and nothing
needed to — the moment they were accepted, `POST /api/products` and `PATCH /api/products/:id`
wrote them straight through `{ ...input }` with no ownership check.

The FK to `membership_tiers` proves a tier **exists**, not who owns it. Verified exploitable:
org B creating a product with org A's `grantsTierId` returned **201**. `grantMembershipsForOrder`
joins the tier with no site scope of its own, so a sale would write a membership row pointing at
another merchant's tier and return that tier's **name** to the buying shopper.

Closed by `assertTiersOnSite` (`lib/queries.ts`), called from both write paths — validated at the
write, because the read paths are many and the write paths are two. Answers `404` rather than
`403`: confirming a tier exists on someone else's store is itself a leak. Regression test in
`tests/integration/tenancy.test.ts`, **confirmed to fail without the guard**.

**The pattern is what to remember.** This is the third instance of the same shape: the integrations
route mutating outside the registry with no permission check, `PUT /api/integrations/:provider`
letting a viewer change the payout address, and now this. Each time, a field became reachable and
the ownership check did not come with it. **Widening an input schema is a tenancy change.**

---

### Scheduled billing — D41 (assistant call, 2026-08-10)

**The problem was an absence.** The threshold fee engine, the meter, period close, and fee
invoicing were all built and all correct, and nothing called them on a schedule. A merchant could
cross their GMV threshold by any margin and never be charged. Threshold pricing is the
differentiator in `docs/PRICING.md`, so this was the gap between a pricing model and a pricing page.

`GET /api/cron/billing`, `0 3 1 * *` via `vercel.json`. Two decisions inside it are worth recording
because both trade against rules stated elsewhere.

**1. A `system` actor is now mintable over HTTP.**

`authorize()` grants a `system` actor every permission without consulting a role, and
`assertStepUp()` waives its second factor. Both were justified by the same comment — system actors
are "migrations, seeds, cron… never reachable over HTTP". A cron job on Vercel *is* an HTTPS request
and nothing else, so shipping one makes that sentence false and converts both bypasses into a hole.

**`CRON_SECRET` is what replaces it.** `lib/cron/auth.ts` is the only code permitted to mint a system
actor from a request, and three properties are load-bearing:

- **A missing secret refuses (503).** Not "allows in development" — an unset variable making the
  endpoint public would hand any caller on the internet an actor that authorizes everything and
  skips MFA. That is the worst default available, and a `?? ""` produces it silently.
- **Constant-time comparison.** The endpoint is unauthenticated by definition and can be probed
  freely, which is exactly the condition a `===` leaks a secret under.
- **A secret under 32 characters refuses.** A guessable secret protecting a permission bypass is not
  protection, and this is the last point anyone would notice.

*Alternatives considered.* Vercel's own `x-vercel-cron` header — rejected, it is not a secret and can
be sent by anyone. A dedicated API token with `billing.write` — rejected: it would need step-up
exemption anyway, and it would put a standing money-moving credential in the token table where a
merchant-facing screen lists it.

**2. The scheduler runs a `high`-risk action unattended, which §22 rule 3 says must not happen.**

Rule 3 states that `high` actions "always require human approval and cannot be configured to
auto-run", and `billing.invoiceAssessments` is `high`. This is a deliberate, narrow exception, and
the reasoning is that rule 3 is aimed at an **agent** proposing a charge on a merchant's behalf. The
cron is the same trust domain as the Stripe webhook that already extends memberships unattended: the
platform operating its own billing cycle on its own timetable. It is bounded by properties the
action already had — each assessment bills at most once, every unsafe case is refused individually
by `assessmentBillable`, and every invocation writes an audit row.

`billing.closePeriod` was deliberately **not** made `high` for this reason: it measures and bills
nothing, so the scheduler needs only one exception rather than two. Keeping close and invoice as
separate steps is what makes that split possible at all.

**Open for the owner to override:** if the rule-3 exception is unacceptable, the fallback is a cron
that closes periods only and leaves invoicing to a human — merchants would then be billed when
someone remembers, which is the status quo this decision exists to end.

---

### MFA scope — D40 (owner, 2026-08-07)

**MFA is mandatory for every merchant account** — at sign-up, at every sign-in, and again as a
step-up before sensitive changes. **Shoppers are never affected.**

Three mechanisms:

1. **Enrolment at account creation.** A merchant account is not usable until a factor is enrolled.
2. **Challenge at every sign-in.** The session reaches `aal2` or it does not reach the dashboard.
3. **Step-up re-authentication on sensitive changes** — a *fresh* `aal2` challenge, valid for a short
   window ("sudo mode"), required again for the next sensitive action. Distinct from (2): having
   signed in with MFA an hour ago is not consent to change where the money goes now.

**This supersedes the earlier payment-scoped version of this decision** (same day). That version
required MFA only once an org turned on an "accept payments" toggle, on proportionality grounds — an
org with no rail has nothing worth stealing. Mandatory-always is the stricter call and it is the one
that stands: it removes an entire class of "not protected yet" window, and it means the payments
toggle needs no enrolment gate of its own, because enrolment already happened at sign-up. The toggle
may still exist as a deliberate opt-in to taking money; it is simply no longer what triggers MFA.

**Shoppers are excluded, and this is load-bearing** (confirmed 2026-08-07). Staff and storefront
customers share one Supabase project (D32), so "require MFA" must key on `user_kind === "staff"` —
the marker only the service role can write. Forcing a second factor on storefront shoppers would
wreck merchants' conversion; they are the merchant's customers, not ours, and a membership buyer is
not an admin.

It would also be **bypassable**, which is the stronger reason. Guest checkout exists — a shopper who
declines TOTP simply does not make an account and still buys, downloads, and receives licence keys.
Mandatory shopper MFA would impose the full friction on the people who *do* register while
protecting nothing an attacker could not reach by not registering. Making it meaningful would mean
removing guest checkout, which is a much larger commerce decision and not on the table.

Where shopper accounts *are* worth protecting, the answer is **step-up on specific actions** rather
than a blanket challenge: re-auth before changing the account email (the recovery vector) and before
re-issuing download links or licence keys. An account takeover then yields a list of past orders and
nothing carryable. Not built.

**Two consequences of mandatory-at-every-sign-in, both easy to discover too late:**

- **Recovery codes stop being optional and become ship-blocking.** When MFA gated only
  payment-accepting orgs, a lost phone was a bad day for a few merchants. Now it locks *every*
  merchant out of *everything*, with a hand-run service-role reset as the only way back. Supabase
  ships TOTP but no backup codes, so these have to be built — hashed, single-use — in the same
  change as enrolment, not after it.
- **The integration suite signs merchants in constantly.** `signUpMerchant` runs in most of the ten
  test files, so a sign-in that demands `aal2` breaks the entire suite at once. TOTP is computable,
  so the fix is for the helper to enrol a factor and derive codes itself — the suite should exercise
  the real MFA path rather than bypass it behind an env flag, which would leave the thing every
  merchant depends on untested.

**What counts as sensitive**, in rough order of what an attacker would actually want:

| Change | Why |
|---|---|
| **x402 wallet address** | **This is the money destination.** Changing it redirects a merchant's revenue to the attacker. Today it is a plain authenticated write (`PUT /api/integrations/x402`) — the single highest-value target in the product, with no step-up on it |
| The payments toggle itself | Turning it off, or on, changes whether money can move |
| Stripe connect / disconnect | Same, for the card rail |
| Staff roles and invites | Privilege escalation — an attacker grants themselves a second way in |
| API token creation | Persistent access that outlives the session and skips it entirely |
| Email / phone changes | Account-recovery vectors; owning these owns the account |
| Disabling MFA | Obvious, and easy to forget |

**Step-up belongs in the action registry, not in route handlers.** §22 rule 1 means there is exactly
one mutation path, so a `requiresStepUp` check beside the existing `riskTier` covers the UI, the
HTTP API, agent tools, and MCP simultaneously — and **an agent cannot route around it**, which is
the whole reason the registry exists. Adding the check per-route would leave the agent path open.

**Still to settle when it is built:**

- **What "accepting payments" means in code.** `chargesEnabled === "true"` for Stripe (connected is
  *not* enough — Stripe gates charges behind verification), or a wallet address on a purchasable
  store for x402. Both rails, since they are peers.
- **The requirement is per-org, but the session is not.** Staff may belong to several orgs, so the
  check belongs where the *active org* is resolved (`getSession`), not at sign-in.
- **Recovery codes are the hard part, not TOTP.** Supabase ships TOTP (`auth.mfa.*`) but **no backup
  codes**. Without our own, a lost phone means a lost store, recoverable only by a service-role
  reset by hand.
- **Enforcement is `aal2`, not enrolment.** Supabase keeps a session at `aal1` until challenged;
  treating "has a factor enrolled" as protected is decoration.

**Built 2026-08-08**, except the enrolment and challenge screens. What shipped, and what building it
turned up:

- **Enforcement is in `getSession()`**, not in the wrappers. `requireSession` (`/api/me`) and
  `requireAuthContext` (every `orgHandler` route) are both real entry points; the first version
  guarded only the second, and `/api/me` served unenrolled merchants until the tests said so.
- **`403 MFA_REQUIRED`, never `401`** — the caller is authenticated, and a 401 loops them.
- **API tokens are exempt.** A scoped token is its own credential minted by an already-protected
  session; refusing it breaks integrations while protecting nothing its holder could not reach.
- **Step-up reads the AMR timestamp, not `aal2`**, with a 15-minute window. The first implementation
  read the claim from the wrong property and always saw `undefined`, so it refused *every* marked
  action — it failed closed, but the integration suite is what noticed, which is why the arithmetic
  now has unit tests.
- **The sequencing concern above was overstated.** Page routes are unguarded, but every screen reads
  data through `/api/*`, all of which funnels through `getSession`. The middleware gap is a UX
  problem (a shell that renders then errors), not data exposure.

**Known: recovery codes do not cascade.** `mfa_recovery_codes.user_id` points at `auth.users` with
deliberately no foreign key — that schema belongs to `supabase_auth_admin`, and coupling the
migration chain to it is the trade `staff.user_id` already declined. So deleting a user leaves ten
rows behind, and nothing sweeps them.

They are **inert**, not exposed: spending a code requires an authenticated session, and there is no
account left to authenticate as. So this is unbounded growth rather than a hole. It showed up first
in the test suite, which was accumulating ten rows per fixture per run (2,390 orphans before it was
noticed) — `removeMerchant` now clears them. In production there is no user-deletion path in Markii
at all today; if one is ever added, it must clear these in the same transaction, because there will
be no scheduler to sweep them afterwards.

**It also uncovered a live privilege hole, which is the part worth remembering.** Converting
`/api/integrations/:provider` into actions — so `requiresStepUp` had somewhere to attach — revealed
the route ran under `orgHandler` with **no `permission` option at all**. Any authenticated staff
member could change the x402 wallet address: the payout destination. That includes `analyst` and
`viewer`, whose role definitions read "reporting only — deliberately no write anywhere".

Both the missing permission and the missing step-up existed for the same reason: the route mutated
outside the registry. That is an argument for §22 rule 1, not an exception to it. It is now
`integrations.connect` / `integrations.disconnect` — `billing.write` (owner and administrator only),
`riskTier: "high"`, `requiresStepUp`, and a diff carrying the old and new wallet address, so "who
redirected the payout, and when" has an answer for the first time.

### Split fee schedule — D39 (owner, 2026-08-06)

**Replaces D1's single threshold and single rate.**

| | Starter | Growth | Scale |
|---|---|---|---|
| Threshold (T12 net sales, **per class**) | $1k | $50k | $100k |
| Physical above threshold | 1.5% | 0.5% | 0.25% |
| Digital / memberships above threshold | 3% | 1.5% | 0.5% |

**The threshold is applied to each class independently.** A Growth merchant with $40k physical and
$40k digital is under the $50k line on both and pays nothing, rather than being $30k over a
combined one. This is why `usage_records.product_class` exists and why a period closes into one
`fee_assessments` row per class — a blended rate would be a number no merchant is charged.

**Why the classes differ.** `docs/COMPETITORS.md` (verified 2026-07-29): Squarespace charges **0%**
on physical goods from Core ($29/mo) and Shopify charges 0% if you use Shopify Payments, so there
is no room to undercut on physical. The same Squarespace plan taxes digital goods and memberships
at **5%**, and a creator must reach $99/mo to escape it — that gap is what the digital rate is
priced into, and D5 already names creators and digital sellers as the beachhead.

**What this costs, stated plainly rather than discovered later:**

- **"No transaction fee until you're big" is no longer the claim.** At a $1k Starter threshold
  essentially every real merchant pays something. The landing page and `docs/PRICING.md` §1
  principle 3 were rewritten to say "below the threshold" rather than "until you are genuinely big".
- **On physical goods Markii is now the more expensive option** against Squarespace Core at Starter
  and Growth. Break-even against Squarespace Core ($29/mo, 0% physical) versus Markii Starter
  ($15/mo annual, 1.5% above $1k) lands near **$12,200/yr of physical sales** — above that a
  physical-only merchant pays more here, and that does **not** reverse at a higher tier: Scale
  still charges 0.25% on physical where Squarespace charges nothing.
- **On digital goods Markii wins at every volume** on Starter: 3% above $1k against Squarespace
  Core's 5% from the first sale. Against Squarespace **Plus** ($49/mo, 1% digital) versus Markii
  Growth ($39/mo, 1.5% above $50k), Markii is cheaper until roughly **$150k/yr of digital sales**.
- **At the top tier the fee comparison goes the other way.** Squarespace **Advanced** is $99/mo
  with **0% on both** physical and digital; Markii Scale is the same $99/mo with 0.25% / 0.5%
  above $100k. On platform fees alone Squarespace Advanced is cheaper at that price point, so
  Scale has to be sold on storefront count, processor freedom, and the agent layer — never on
  being the cheapest fee.
- The **0% platform fee for bringing your own processor** is untouched on every plan, and remains
  the differentiator that survives this change intact.

**Scale rates were 0% / 0% when D39 was first recorded and changed to 0.25% / 0.5% the same day**
(owner). The $100k Scale threshold is therefore load-bearing rather than decorative — under it a
Scale merchant still pays nothing.

### D4 note — Connect account types, plainly

The underlying question: **is the merchant Stripe's customer, or is Markii?**

| | **Standard** | **Express** | **Custom** |
|---|---|---|---|
| Whose Stripe account | Merchant's own | Platform-tied | Platform-controlled |
| Merchant has a Stripe dashboard | Full | Limited | None |
| Who sets the card rate | Stripe → merchant | Markii | Markii |
| Merchant can negotiate at volume | ✅ | ❌ | ❌ |
| Dispute / negative-balance liability | Merchant | Largely Markii | Markii |
| Onboarding friction | Higher — redirect to Stripe, full KYC | Low — Stripe-hosted, fast | Fully custom |
| Markii's control & margin | Least | More | Most |

**Why this is load-bearing.** `docs/COMPETITORS.md` lists *"your Stripe account, your rates —
negotiate directly at volume"* as a defensible claim. It is **only literally true under Standard**.
Under Express or Custom, Markii sets the merchant's effective rate and the merchant cannot go
negotiate with Stripe, because they are not Stripe's customer — which is structurally the Shopify
Payments model Markii is positioning against.

It also touches a standing principle (`docs/PLAN.md` §3): **never hold merchant funds.** Standard
keeps money flowing merchant↔Stripe with Markii never in the middle. Express and Custom move Markii
closer to being a party to the funds flow, which is where money-transmission questions begin.

**Scope of the block:** Phase A is unaffected. This blocks **Phase B/C**, because the integration
genuinely differs — OAuth connect vs hosted onboarding, how charges are created, who receives
funds, which webhooks matter — and it blocks the public pricing claim.

### Final shape — Connect Standard (owner, 2026-07-29)

**Connect Standard is the integration model.** Express stays a possible later option, not a planned
step. Direct API keys were considered and dropped: their main justification was self-hosting, and
self-hosters supply their own infrastructure, payment provider, database, and auth anyway (D26) —
so the hosted product should not carry the security burden of storing live merchant secrets to
serve a case that does not need it.

**0% platform fee, and no `application_fee_amount` on any charge.** Markii's revenue is the
subscription and the threshold fee, billed on Markii's own invoice — it never touches the
merchant's payment flow. Shopify does the opposite: their processor is the default and merchants
are taxed up to 2% for leaving.

### Should Markii negotiate rates on merchants' behalf? — **No**

The question behind Express/Custom: aggregate all merchant volume under Markii, negotiate a better
blended rate with Stripe, pass it down — the Shopify Payments model. Four reasons not to:

1. **No leverage for years.** Stripe offers meaningful custom pricing only at serious processing
   volume. Promising "we negotiate for you" before that is a promise Markii cannot keep.
2. **Liability inverts.** Express/Custom puts Markii in the funds flow: negative balances, dispute
   liability, fraud exposure. A merchant who accumulates chargebacks and disappears leaves Markii
   holding it. That requires a risk and underwriting function — a team, not a feature.
3. **It reopens money transmission.** Being a party to merchant funds is the exact thing
   `docs/PLAN.md` §3 avoids.
4. **Zero upside under a 0% platform fee.** Under Express the platform is generally responsible for
   Stripe's fees and therefore sets what the merchant pays. With no platform fee, Markii would pay
   Stripe and pass through at cost — administration and liability for no margin. *(Fee-liability
   configuration varies by Connect setup; verify against current Stripe docs before building
   Express.)*

**The benefit is also smaller than it sounds.** Negotiating your own rates only pays off above
roughly **$1M/yr** in volume. Below that a merchant gets Stripe's standard 2.9% + 30¢ whether they
negotiate or not — no leverage either way. So for most of the target market, Standard versus
Express makes **no rate difference at all**; Express only buys smoother onboarding.

**Where the real differentiator sits:** Markii's advantage is not a better rate, it is **no platform
fee on top of the rate** — Shopify charges up to 2% for using your own processor and Squarespace
takes 5% of digital sales. The "negotiate directly at volume" line is a true secondary benefit for
large merchants (they *cannot* do this on Shopify Payments), but it should never be the headline.

### Could Markii absorb processing costs itself? — **No, not at any tier**

Asked and costed 2026-07-29. Processing fees are one to two orders of magnitude larger than
subscription revenue for any real merchant.

| Merchant | Monthly GMV | Stripe fees (~2.9% + 30¢) | Markii revenue | Ratio |
|---|---|---|---|---|
| Starter, 100 orders × $50 | $5,000 | **~$175** | $19 | **9×** |
| Growth, 500 orders × $100 | $50,000 | **~$1,600** | $39 | **41×** |
| Scale, 2,000 orders × $150 | $300,000 | **~$9,300** | $129 | **72×** |

Processing overtakes subscription revenue at roughly **$633/mo GMV on Starter** — every merchant
worth having is past that immediately.

**The liability asymmetry is worse than the cost.** Under Express, a merchant taking $10,000 in
chargebacks beyond their balance leaves the platform holding it — about **44 years** of Starter
subscription revenue from that merchant, or 8+ years from a Scale merchant. One bad actor erases a
cohort.

**Why this is structural, not a pricing tweak.** Shopify can be generous with payments because
processing *is* their revenue and subscriptions are the smaller line. Markii inverted that
deliberately: subscription-only, 0% platform fee. That is a sound model, but it permanently fixes
processing cost at 10–70× per-merchant revenue, so Markii can never subsidize it. Staying out of the
payment flow is the only survivable structure here — not merely a principled preference.

**The one affordable version** is a bounded acquisition promo, never a feature: *"we cover Stripe
fees on your first $1,000 in sales"* costs ~$29 per merchant once, is capped, and can be switched
off. Permanent absorption is off the table at every tier.

**If Express is ever built,** it must stay unpenalized — same subscription price, no platform fee —
and it must pass Stripe's fees through at cost, never absorbed. If it ever becomes the default or is
priced differently, the "your own rates" claim comes down from every surface at the same time.

### Beachhead — D5 (decided: creators & digital-goods sellers)

**Decision made by the assistant on 2026-07-29 so planning can proceed. Easy to override —
it changes onboarding, templates, demo data, and landing copy, not the architecture.**

**The deciding argument is not pricing — it is that Markii's biggest scope gap disappears.**
`docs/PLAN.md` §3 excludes fulfillment logistics entirely: no carrier rates, labels, pick/pack,
3PL, or returns. For a merchant selling courses, templates, memberships, downloads, or licences,
**none of that is ever needed.** The platform's most conspicuous weakness becomes irrelevant for
this segment. No other segment has that property.

Supporting reasons:

1. **A verified, punitive competitor gap.** Squarespace charges **7% / 5% / 1% / 0%** on digital
   content and memberships — a creator pays 5% at $29/mo and must reach **$99/mo** to escape it. At
   0% on every plan, a creator doing $100k/yr in digital sales saves ~**$5,000/year** against
   Squarespace Core. That is a single number, not an architecture story.
2. **Shopify is weak here.** It is a physical-goods platform; digital selling needs third-party apps.
3. **Lowest support burden of any segment** — no shipping questions, no lost-package tickets, no
   returns. Support is the real margin risk at $19/mo (D2), so this compounds directly.
4. **The agent-purchase demo actually completes.** x402 settles instantly with no address and no
   shipping — an agent can genuinely discover, buy, and receive a digital product end to end. For
   physical goods the story stops at "order placed."
5. **Agent-legible by nature.** Digital products have no size, weight, or shipping variables, so
   the readiness score and JSON-LD are clean and simple.

**Risks, honestly:**

- **Chargeback exposure is higher.** Digital goods are a classic fraud and friendly-fraud target
  with no delivery proof. This raises the stakes on D20 (disputes) and G12 (abuse) sooner than a
  physical-goods beachhead would.
- **Bandwidth and storage cost.** Large file delivery hits exactly the line D2 has not yet modeled
  (Supabase Storage + egress). **G5 storage limits become urgent, not deferrable.**
- **Smaller TAM** than physical commerce, and a narrower brand if over-committed to.

**Scope consequence — new P0 work this implies.** Digital selling needs features not currently in
any phase: secure/expiring download delivery, download limits, licence-key issuance, membership and
content gating, and subscription-style recurring access. Fold into **Phase C**; none is large, but
none is currently planned.

**What would change this call:** physical-goods merchants already lined up as design partners; an
investor or demo narrative that needs a conventional store; or storage/bandwidth economics turning
out worse than the D2 model assumes.

**Not a market restriction.** The platform stays general-purpose — this decides who the first
onboarding, templates, demo data, and landing page are built for.

---

## 🟠 Phase-gated

### Before Phase B (billing)
| ID | Decision | Recommendation |
|---|---|---|
| D7 | Threshold basis: trailing 12mo / calendar year / plan year | **Trailing 12 months** (BigCommerce validates it; avoids a January reset cliff) |
| D8 | Fee application: marginal on the excess vs on all sales once crossed | **Marginal** — no cliff, ever |
| D9 | Trial length; card required up front? | 14 days, no card; fees accrue and display but are not charged |
| D10 | Dunning restriction ladder and grace period | Storefronts stay live; restrict dashboard writes/publishes first. Hard suspension last |
| D11 | Do annual prepayers get any threshold credit? | No — keep the model explainable |

### Before Phase C (commerce)
| ID | Decision | Recommendation |
|---|---|---|
| D12 | Fulfillment scope: is manual status + tracking entry enough for launch? | Yes. No carrier rates, labels, 3PL, or returns logistics |
| D13 | Is Orders read-only at launch, or does it include refunds/cancels? | Include refunds and cancels — a store that can't refund isn't usable |
| D14 | Media storage limits per plan | Needs a number; see 🔵 G5 |

### Before Phase D (builder)
| ID | Decision | Recommendation |
|---|---|---|
| D15 | ~~Cloneability / code export~~ | Largely resolved by **D26** — public source means self-hosting is documentation, not a build. Remaining question is only whether *hosted* merchants get a one-click export |
| D16 | Raw template-language access, or only the four custom-code levels? | Four levels; revisit if developers ask |
| D17 | Concurrent human↔agent editing conflict policy | Last-write-wins with a visible warning; per-node locking only if testing demands it |
| D18 | May agents auto-execute low-risk builder actions (spacing, alt text)? | Per-store opt-in, default off. High-risk never auto-executes |
| D19 | Theme marketplace; theme export/import between stores | Post-launch |

### Before Phase E / F
| ID | Decision | Recommendation |
|---|---|---|
| D20 | Chargeback stance | Three-way split: visibility free, assisted response paid, **no financial guarantee** |
| D21 | Does the ops agent touch customer records? | Aggregate only, never individual PII |
| D22 | Scheduled/proactive agent runs ("watch inventory nightly") | Add-on v2; needs its own consent model since it acts unattended |
| D23 | Catalog Health and Agent Readiness — one module or two? | One, at `/dashboard/health` |
| D24 | Is Agent Test Lab plan-gated? | No — consistent with API/MCP on every plan |
| D25 | Which channels launch as active / beta / coming soon? | Needs a call once channel work starts |

---

## 🔵 Gaps that were unplanned — now resolved

These need a decision before they can even be specced.

| ID | Gap | Note |
|---|---|---|
| ~~G1~~ | ~~Email~~ | ✅ **AWS SES** for merchant mail (own verified domains) · **Resend** for Markii's own platform mail only. Sending identity, shopper-auth hook, and streams all settled — §"Email — G1 in full" |
| ~~G2~~ | ~~Launch countries and currencies~~ | ✅ **US, Canada, UK, Australia first; EU as a fast follow, not a deferral** — the merchant is the seller of record, so Markii is not the taxpayer. §"Remaining gaps resolved" |
| ~~G3~~ | ~~Sales tax on Markii's own subscription~~ | ✅ **Stripe Tax on subscriptions from day one**, register as thresholds are crossed |
| ~~G4~~ | ~~Support model~~ | ✅ **Human escalation on every tier**; first response 2 business days / 1 business day / 8 business hours (Starter / Growth / Scale) |
| ~~G5~~ | ~~Media storage limits~~ | ✅ **Gated per plan, Wix-style — plus bandwidth, which Wix does not gate** (owner, 2026-07-29). See §"Media gates — G5" |
| ~~G6~~ | ~~Storefront search~~ | ✅ **Postgres full-text search** (tsvector), no separate search vendor. Phase C |
| ~~G7~~ | ~~Cookie consent / GDPR~~ | ✅ **Markii's own storefront analytics are cookieless and server-side — no banner needed.** Consent banner is a builder block for merchant-added third-party trackers |
| ~~G8~~ | ~~Uptime, backups, DR~~ | ✅ **No published SLA at launch.** Public status page, Supabase PITR backups, internal RTO/RPO targets. SLA only for a later enterprise tier |
| ~~G9~~ | ~~Domain~~ | ✅ **markii.shop** (owner, 2026-07-29). Trademark deferred. Storefront-subdomain naming flagged — §"Remaining gaps resolved" |
| ~~G10~~ | ~~Team capacity~~ | ✅ **Two people: one frontend, one backend (owner)** (2026-07-29). Forces a smaller launch scope — §"Team & launch scope — G10" |
| ~~G11~~ | ~~Data residency~~ | ✅ **Deferred.** US region at launch; EU region only when a customer contractually requires it. This — not latency — is what would force multi-region |
| ~~G12~~ | ~~Abuse and rate limits~~ | ✅ Per-org API rate limits, storefront fair-use, email verification + SES sending caps for new merchants, manual review above thresholds |

---

## Unit economics — D2 (costed 2026-07-29)

**Verdict: D1's pricing holds.** ~85% gross margin at scale on a $19/mo Starter. But the model is
**scale-dependent**, and the thing that threatens it is not infrastructure.

Vendor rates below are [1P], fetched 2026-07-29. **Everything else is a modeled estimate from
stated assumptions, not a measurement** — re-run against real telemetry once merchants exist.

### Vendor rates

| Vendor | Rate |
|---|---|
| Vercel Pro | $20/user/mo · 1 TB transfer incl., then **$0.15/GB** · invocations **$0.60/1M** · Active CPU **$0.128/hr** · ISR reads **$0.40/1M**, writes **$4/1M** · image transforms **$0.05/1K** · 10M edge requests incl., then **$2/1M** |
| Neon Launch | **$0.106**/CU-hour · **$0.35**/GB-month · scale-to-zero disableable |
| Neon Scale | **$0.222**/CU-hour · **$0.35**/GB-month |
| Resend | Free 3k · Pro $20/50k, $35/100k (**10 domains**) · **Scale $90/100k (1,000 domains)** · ~$0.90/1k overage |
| Stripe Billing | **0.7%** of billing volume (pay-as-you-go) |
| Stripe payments | 2.9% + 30¢ on Markii's own subscription charge |

### Modeled Starter merchant

Assumptions: 1 storefront, 10k pageviews/mo, 100 orders/mo, ~50 MB data, pages served from ISR
cache so the database is off the hot path.

| Line | At ~1,000 merchants | At ~100 merchants |
|---|---|---|
| Vercel (bandwidth-dominated) | ~$0.45 | ~$0.65 |
| Supabase — DB + auth + file storage, amortized | ~$0.25 | **~$1.45** |
| Email — SES merchant mail (~250) + Resend Pro amortized | **~$0.05** | ~$0.23 |
| Stripe on a $19 monthly charge | **~$0.85** | ~$0.85 |
| **Total** | **≈ $1.60** | **≈ $3.20** |
| **Gross margin on $19/mo** | **≈ 92%** | **≈ 83%** |

*Revised 2026-07-29 after D6 (Supabase) and the G1 email split. Both decisions cut cost materially:
Supabase is cheaper than Neon **and absorbs the previously uncosted file-storage line**, while
splitting email keeps Resend on the $20 Pro tier and moves bulk volume to SES at $0.10/1k. Margin
at 100 merchants improved from ~69% to ~83%, which meaningfully softens the early-scale squeeze.*

### Five findings that matter more than the totals

1. **Database compute is a fixed cost, and it is punishing early.** A shared Neon Scale instance at
   ~2 CU is ~$324/mo whether it serves 10 merchants or 1,000. Below roughly **200 merchants**, fixed
   costs dominate and margin compresses toward 60%. This is a funding-runway question, not a pricing
   question — do **not** raise Starter to fix it.
2. **Stripe's 30¢ fixed fee punishes monthly billing.** On a $19 monthly charge, Stripe takes
   ~$0.85 = **4.5% of revenue**. On annual ($180 once) it is ~$6.80/yr = **3.8%**. Annual billing is
   already discounted for the merchant *and* materially cheaper for Markii — worth pushing harder in
   the UI than a typical "save 20%" nudge.
3. **The AI layer must stay rule-based on included plans.** `docs/PLAN.md` promises the readiness
   layer on every tier. If readiness runs live model inference per product, per merchant, it will
   dwarf every line in the table above. Keep the score **deterministic and rule-based** (already the
   plan in `docs/API.md` §9), and confine metered inference to Agent Test Lab and the Agent Ops
   add-on where it is separately paid for.
4. **Resend's domain cap is a real constraint.** Pro allows only **10 domains**; per-merchant
   verified sending domains (§G1) therefore requires **Scale at $90/mo for 1,000 domains**, and
   Enterprise beyond ~1,000 custom-domain merchants. Budget for Scale from the first paying cohort.
5. **Support cost dwarfs infrastructure.** One 15-minute ticket at a $30/hr loaded cost is **$7.50 —
   roughly 40% of a month's Starter revenue**, or about 3× the entire infra bill. Margin at the low
   end is a *support-design* problem: self-serve onboarding, good empty states, and docs are the
   margin lever, not server cost. This directly feeds G4.

### Not yet costed

- **Media storage and egress.** Now Supabase Storage ($0.125/GB stored, $0.09/GB egress above
  250 GB) rather than the uncosted Vercel Blob line — rates are known, but real usage is not.
  Model it before answering **G5 (storage limits)**. Unlimited media on a $15 plan remains the most
  plausible way this model breaks, and the D5 beachhead makes file delivery a **core** workload.
- **Bandwidth outliers.** 1 TB covers ~500 modeled merchants, but a single video-heavy or viral
  store can consume it alone. A fair-use policy is needed, not just a storage cap.
- **Neon compute under real load** — the 2 CU assumption is a guess until there is traffic.

### Actions

- Keep D1 as accepted. Do not raise Starter.
- Model Supabase Storage usage against digital-delivery workloads and answer **G5** with a real
  number — the D5 beachhead makes this urgent, not deferrable.
- Add a **fair-use bandwidth policy** to the plan table before launch.
- Treat **200 paying merchants** as the break-even-ish milestone where margin normalizes.
- Design support to be self-serve first (**G4**) — that is where the money actually goes.

---

## Distribution — D26 (decided: both) and the licence question

**Decision: public source + hosted cloud** (owner, 2026-07-29). The repo is already public.

This also largely **answers D15**: if the code is public and self-hostable, "export your store"
stops being a build and becomes documentation.

### Licence: **FSL-1.1-ALv2** (decided 2026-07-29)

**Functional Source License 1.1, Apache 2.0 future licence** — [fsl.software](https://fsl.software/),
verified 2026-07-29.

> A public repo with no `LICENSE` file is **"all rights reserved" by default** — nobody may legally
> self-host it and no external contributor can safely open a PR. Adding this file is the action item.

**What FSL does:** permits running the software for almost any purpose, studying it, modifying it,
and distributing changes. Restricts only **competing commercial use** — someone launching a hosted
"MarkiiCloud" against your own service. Each version **auto-converts to Apache 2.0 two years after
its release**, so it is genuinely Fair Source rather than permanently proprietary.

**Why this one:**

| Option | Verdict |
|---|---|
| MIT / Apache outright | ❌ Anyone — including a major cloud — could host Markii as a competing SaaS. For a business whose entire revenue *is* hosting, that is existential |
| AGPL-3.0 | ❌ Weaker than it looks (a competitor complies by publishing modifications) and many enterprises ban AGPL outright, cutting off buyers |
| BSL | ⚠️ FSL's predecessor. FSL standardizes it, drops the variable "Additional Use Grant," and shortens conversion from **4 years to 2** |
| Elastic License 2.0 | ⚠️ Similar intent but never converts to open source — less community-friendly |
| **FSL-1.1-ALv2** | ✅ Permits self-hosting (the D26 decision), permits contribution, blocks resale-as-a-service, converts to Apache in 2 years |

**Apache rather than the MIT variant** because Apache 2.0 carries an express **patent grant and
patent-retaliation clause** — meaningful for a commercial product — and enterprise legal teams
accept it more readily.

**Ship alongside the licence:**

- `LICENSE` — FSL-1.1-ALv2 template, with the copyright holder set to the legal entity (**G9**)
- `CLA` — a Contributor Licence Agreement (not just a DCO), so relicensing stays possible later.
  CLA Assistant automates this on PRs
- `TRADEMARK.md` — Apache 2.0 explicitly does **not** grant trademark rights, and FSL follows.
  Forks may use the code; they may not call it "Markii". State this plainly
- `NOTICE` or README section listing what is **cloud-only** and therefore not in the repo

⚖️ **Have counsel review before launch.** This is a reasoned recommendation, not legal advice, and
the licence is the one decision here that is expensive to reverse after third parties rely on it.

### Self-hosters bring their own everything (owner, 2026-07-29)

**Self-hosted deployments supply their own infrastructure, payment provider, database, auth, and
email.** Markii ships the code; operating it is theirs.

This is a load-bearing simplification: **the self-hosted variant does not constrain hosted
architecture decisions.** It is why direct Stripe API keys were dropped from D4 — their main
justification was making Connect work for self-hosters, and self-hosters do not need Markii to
solve payments for them. Apply the same test to future decisions: if a design choice exists only to
serve self-hosters, it probably should not shape the hosted product.

### Also decide

- **What is cloud-only?** Candidates: managed hosting, the AI layer's hosted inference, Agent Ops
  billing/metering, analytics pipeline. Self-hosters get the platform; they do not get Markii's
  Stripe platform, managed infrastructure, or free inference.
- **Contribution policy** — CLA/DCO, and whether external PRs are welcome at all pre-launch.
- **Public strategy is now public.** `docs/PRICING.md` and `docs/COMPETITORS.md` are in a public
  repo, so the threshold model, the margin analysis above, and the competitive positioning are
  readable by Shopify, Squarespace, and anyone else. That is a defensible trade — the strategy is
  hard to copy without restructuring their own processor economics — but it should be a **choice**,
  not an accident. If any of it should be private, move it now, before the first external eyes.

---

## Auth — D3 (decided, with open verifications)

**Decision: Supabase Auth** (owner, 2026-07-29). Originally Neon Auth; superseded when **D6** chose
Supabase. The D3↔D6 coupling was flagged when D3 was first decided — this is it resolving.

**Why it fits.** Users live in Markii's own Postgres, so staff records join directly against orgs,
stores, and audit rows — no reconciliation against an external directory, no second source of truth
for "who is this person." Supabase Auth is also the more mature product (better docs, MFA, SSO,
wide adoption), it is included in the plan (100k MAU), and it is open source and self-hostable —
which matters for **D26**.

**Verify before Phase A is locked** — these are requirements the architecture already committed to,
not hypotheticals. Check each against current Neon Auth documentation rather than assumption:

| # | Requirement | Where it comes from |
|---|---|---|
| 1 | **httpOnly cookie sessions**, not `localStorage` tokens | Hard rule in `CLAUDE.md` — merchant custom code runs on storefronts, and XSS there must never reach an admin session. ✅ **Resolved in detail by D30** — "use the SSR integration" was too loose a phrasing and was read as `createBrowserClient`, which cannot set `HttpOnly`. See §"Session transport — D30" |
| 2 | **A user belonging to multiple organizations** | Agencies building stores for clients (`docs/API.md` §16). If unsupported natively, org membership becomes Markii's own table with Neon Auth only supplying identity — workable, but decide deliberately |
| 3 | **MFA**, and org-wide enforcement by an Owner | `docs/API.md` §16 |
| 4 | **Two isolated identity domains** — staff vs storefront customers | Staff auth and shopper accounts must share no session, cookie namespace, or token audience. If Neon Auth cannot cleanly host two separate user pools, **customer accounts need their own solution** (Phase C, §18.3). This is the most likely gap |
| 5 | **SSO/SAML** availability later | Enterprise tier; must not be foreclosed |
| 6 | Scoped machine tokens for API/MCP | Likely Markii's own table regardless — fine, just confirm it isn't fighting the provider |

**Accepted trade-off:** this couples auth to the database vendor. If D6 is ever revisited — most
plausibly for data residency (G11) — auth migrates at the same time as the data. That is a real
cost, but it is a low-probability path and the day-to-day benefit of joinable user records is worth
it. Note it so the coupling is a choice rather than a surprise.

**Fallback if a verification fails:** a managed provider (Clerk via the Vercel Marketplace, Auth0,
Descope) remains the alternative. Requirement 4 is the one most likely to force a split — in which
case the clean shape is Neon Auth for staff, and a separate, simpler mechanism for storefront
customers, which is a normal arrangement for commerce platforms.

---

## Session transport — D30 (resolves D3 item 1)

**Decision: every auth mutation runs server-side, and the browser never holds a Supabase session**
(assistant call, 2026-07-30 — owner may override).

**The conflict this settles.** D3 item 1 said "use the SSR/cookie-based integration, not the default
browser client." That phrasing is ambiguous, and the first implementation took the ambiguous reading:
[`components/auth/auth-form.tsx`](../components/auth/auth-form.tsx) calls
`supabase.auth.signInWithPassword()` on `@supabase/ssr`'s `createBrowserClient`. That *is* the SSR
package, and it *does* keep the session in cookies rather than `localStorage` — so it satisfies the
letter of the rule. It cannot satisfy the intent: **a cookie written by `document.cookie` can never
carry `HttpOnly`.** The session stays readable by any script on the origin, which is the exact
exposure `CLAUDE.md` bans, because merchant custom code runs on storefronts.

The lesson worth keeping: "SSR integration" is not the requirement. **Where the mutation runs** is.

| | Settled shape |
|---|---|
| Where auth mutations run | **Server only** — route handlers under `/api/auth/*` using `createServerClient` (`docs/API.md` §16) |
| What the browser does | Posts credentials to Markii's own origin. The client never calls Supabase Auth directly |
| Cookie flags | `httpOnly: true`, `secure: true`, `sameSite: "lax"` — set on the response, server-side |
| `createBrowserClient` | **Not used anywhere in the dashboard.** Its presence is the smell that this decision was bypassed |
| Session refresh | `proxy.ts` runs the SSR middleware helper on dashboard requests; expiry is never the client's problem |
| How the UI learns who you are | `GET /api/me` — never a client-side session read |
| Cookie adapter shape | `getAll` / `setAll`. The `get`/`set`/`remove` triple is deprecated in `@supabase/ssr` ≥ 0.10 and loses chunked-cookie handling for large sessions |

**The trade-off, stated plainly:** httpOnly sessions mean the browser cannot talk to Supabase
directly — no client-side queries, no Realtime channel authenticated as the user. That is already
the architecture (`CLAUDE.md`: screens call `/api/*` only, never `lib/db`), so today it costs
nothing. Deciding it now is what stops something from quietly coming to depend on browser-side
Supabase and making the fix expensive later.

**Storefront customer auth (§18.3) inherits the same shape** — server-side mutations, httpOnly
cookies, separate cookie name and route namespace. **Superseded in part by D32:** shoppers and staff
now share one Supabase project, so they no longer have separate token audiences. The isolation
requirement survives; the mechanism changed from "different project" to "explicit `user_kind` guard
plus host-only cookies."

---

## Identity isolation — D32 (supersedes part of G1-identity and D3 item 4)

**Decision: one Supabase project for both staff and storefront shoppers** (owner, 2026-07-31,
reversing the two-project split in G1-identity).

**What changed the answer.** Two arguments were originally made for separate projects. On
re-examination only one survives:

| Original argument | Holds? |
|---|---|
| One project allows only one SMTP from-address, so merchant-domain shopper mail needs its own project | **No — this was overstated.** G1 already specifies Supabase's **Send Email Hook**, which picks the sender per merchant from user metadata *within a single project*. The hook solves it; separation was never required for this |
| Separate projects mean separate JWT signing keys, so a shopper token cannot be a structurally valid staff token | **Yes**, but it is defence in depth rather than a fix for a live hole — `getSession()` already resolves a user through their `staff` row, so a shopper with no membership gets `null` → 401. It fails closed today |

**Why one project wins here.** `auth.users` becomes joinable: `customers` can carry a real foreign
key, deletes cascade, and "this shopper and their orders" is one query instead of a reconciliation
against an external directory. Against that, the team is two people with a single support address,
and a second project is a second bill and a second set of credentials to operate.

**Three mitigations are binding, not advisory.** They are what the project split was providing for
free, and they now have to be held deliberately:

1. **Never authorize on `supabase.auth.getUser()` alone.** Membership lookup is the gate. This is
   already how `lib/auth/session.ts` works; the change is that it becomes load-bearing rather than
   incidental, so it must not be bypassed by any future route.
2. **Host-only session cookies — never `domain=.markii.shop`.** A cookie scoped to the parent domain
   flows to every `{slug}.markii.shop` storefront, where merchant custom code runs. That is the D30
   exposure reappearing through a different door.
3. **An explicit `user_kind` on the user record**, checked on every path, so "shopper" and "staff"
   are a stated property rather than something inferred from which table happens to have a row.

**Cost of being wrong, stated plainly.** Splitting later means recreating shopper auth users in a
new project and forcing password resets on real customers. Unpleasant, not impossible. The decision
does not bind until customer accounts ship (§18.3) — nothing built for Phase A assumes either
answer.

**Revisit if** a merchant brings a genuine enterprise security review, or shopper volume starts
driving the auth bill and rate limits in a way that makes separate metering worthwhile.

---

## Checkout totals — D33 (decided while building §18.4, 2026-07-31)

**Decision: a money component carries a `state`, and only *shipping* can block a sale.**

**The problem.** `docs/BACKEND.md` §4 says recompute everything server-side; `CLAUDE.md` says never
imply something happened when it didn't. Discounts (§18.5) and tax and shipping (§18.6) are not
built. Returning `taxMinor: 0` satisfies the first rule and breaks the second — a shopper reading
"$0.00 tax" has been told a fact nobody established. So every component returns
`{ amountMinor, state: "calculated" | "none" | "not_configured", note }`, and the storefront must
render the state, not just the number.

**The harder question was what to do about it**, and the first implementation got it wrong. Gating
checkout on "every component calculated" made *every* checkout unreachable — a verification harness
caught it when an unsupported discount code blocked an otherwise valid sale. The corrected rule
splits the three cases by **who pays for the gap**:

| Component | Today | Blocks checkout? | Why |
|---|---|---|---|
| Discount | `not_configured` when a code is present | **No** | The shopper pays list price — the correct price for the goods — and is told plainly the code did nothing. Refusing would lock a shopper out of a valid sale over a code the store never offered |
| Tax | `none`, stated as tax-inclusive | **No** | Not a guess: §18.6's own "prices-include-tax flag" describes this, it is how most storefronts outside the US work, and it is how this platform has sold since v1. Adding a `$0.00` tax *line* to a total that should carry tax would under-collect — saying prices already include it does not |
| Shipping | `none` if nothing needs it, else `not_configured` | **Yes — 409** | The cost is real and someone pays it. Quoting zero means the merchant does, silently, without agreeing to it |

`totalState: "final" | "provisional"` answers exactly one question — *is this safe to charge?* — and
is the only field a checkout button should read.

**Consequence to know:** a store selling anything with `requiresShipping` cannot check out until
§18.6 lands. That is deliberate and is the strongest argument for doing §18.6 next. Digital goods
and every product predating §18.1 variants check out today, which is also the D5 beachhead.

**Updated 2026-07-31 (§18.6 shipped).** Shipping and tax now come from real configuration, and the
gate widened by one: **tax `not_configured` also blocks**, because a merchant who selected a tax
provider is telling us they collect tax, and completing a sale without it leaves them owing money
they never charged. A store on `provider: "none"` is unaffected and still checks out — the D33
tax-inclusive default is now an explicit setting rather than a hardcoded assumption. Discounts still
never block.

---

## Overselling — D34 (decided while building §18.4, 2026-07-31)

**Decision: `SELECT … FOR UPDATE` on the variant row inside the reservation transaction.**

`docs/BACKEND.md` §4 required "a database transaction or constraint, not an application-level
read-then-write" and did not say which. The lock was chosen over a check constraint because the
inventory level is a **sum over the append-only ledger**, not a column — there is no single value to
constrain. Locking the variant row serialises every checkout touching it, so the level read
immediately after cannot be stale by the time the hold is written.

Two supporting choices:

- **Reservations are taken in ascending variant id.** Two carts holding the same two variants in
  opposite orders would deadlock; ordering makes that impossible rather than unlikely.
- **`inventory_reservations` exists alongside the ledger, and is not redundant.** The ledger records
  *movement* and answers "why is this number 3?". The reservations table records *state* — what is
  held, by which session, expiring when — which an append-only ledger cannot express without a
  scan. Release becomes an indexed lookup and the expiry sweeper has something to sweep.

**Verified**, not assumed: 8 concurrent checkouts against 3 units, 6 rounds, exactly 3 winners every
round and never 4.

**Known gap:** products predating §18.1 have no variant and therefore no ledger, so they still
decrement `products.stock` and are **not** protected by this lock. Reading the wrong one of the two
stock sources oversells, which is why `lib/commerce/pricing.ts` picks the source in exactly one
place. The gap closes by migrating products to variants, not by inventing a ledger they never had.

---

## Free-shipping thresholds — D35 (decided while building §18.6, 2026-07-31)

**Decision: `minSubtotalMinor` means one thing — an eligibility bound — for every rate type.**

The first implementation overloaded it: a *bound* for `price_based`, and a *free-at line* for
`free_over_threshold`, with `priceMinor` charged below it. A verification harness caught the result
immediately — a rate named "Free over $50" **failed to appear at $40 and charged money at $60**,
which is the opposite of both halves of its name.

`free_over_threshold` is now offered **only** at or above its threshold and is always free;
`priceMinor` is forced to `0` by the action layer so nobody configures a number that can never be
charged. A merchant wanting a price below a threshold and a lower one above it creates two
`price_based` rates, which is what that type is for.

**The general rule this is an instance of:** one field, one meaning. A field whose semantics depend
on a sibling's value cannot be validated coherently, and the failure mode is silent — the rate looks
configured and quietly misprices.

Related: **a selected rate is always re-quoted, never trusted from the cart.** A cart that shrinks
below a free-shipping threshold loses the selection and returns to `provisional` rather than
staying free, which is the same "recompute, never trust" rule as D33 applied to shipping.

---

## Metering base — D36 (bug found and fixed 2026-07-31)

**The `UsageRecord` meters net sales — `subtotal − discounts` — never the order total.**

`docs/PRICING.md` §4.1 already defined this ("excludes: taxes, shipping charges…"), but the §18.4
implementation wrote `session.totalMinor`, which *includes* both. The threshold meter would have
billed merchants against tax they merely collected on a government's behalf and postage they passed
straight through — **and worst for whoever ships the most**, which is the opposite of what a
size-based threshold is meant to measure.

Caught while reading §4.1 to build discounts, not by a test, which is the useful part: the number
was internally consistent and every §18.4 check passed. Only the written definition disagreed with
it. **The lesson is that a figure feeding a pricing decision needs checking against its spec, not
just against itself** — a self-consistent wrong number is invisible.

Now covered by a check asserting the metered amount differs from the charged amount on any order
carrying shipping.

---

## Discount stacking — D37 (decided while building §18.5, 2026-07-31)

**Decision: stacking is opt-in on both sides, and all three `combinesWith` flags default to false.**

A second discount joins the first only if *each one's* flag permits the other's kind
(product / order / shipping). One-sided permission is not enough.

**Why the strict default.** Combinable-by-default is how a store wakes up having sold its catalogue
at 70% off — the failure is silent, fast, and unrecoverable, since the orders are real. The opposite
error, a merchant having to tick a box to run a stacked promotion, costs one support question.
Asymmetric consequences justify the asymmetric default.

**Related rules that fall out of the same reasoning:**

- A `fixed` discount never exceeds the base it applies to, and total discount never exceeds the
  subtotal. An order can reach zero; it can never go negative.
- A discount matching nothing in the cart is **rejected with a reason**, not applied as zero.
- Rejections are specific — ten distinct reasons, including the shopper's current subtotal when they
  are below a minimum. "Invalid code" for all ten leaves someone £2 short with no idea they are £2
  short, and that is a sale lost to a message rather than a price.

**Known race, stated rather than papered over:** two checkouts of a last-remaining use can both
complete, exceeding `usageLimit` by one. The unique key on `(discountId, orderId)` stops one order
counting twice, not two orders racing. Refusing at completion is worse — on the x402 rail the
shopper has already settled on-chain, so it would take their money and give nothing. Closing it
properly needs a reservation like inventory's (D34), which is the right fix if over-redemption ever
costs more than the payments it would strand.

---

## Testing — D38 (decided 2026-07-31, after Phase C)

**Decision: Vitest, two suites split by what they need — `unit` (pure, ~1s, no
dependencies) and `integration` (real HTTP, real database, ~10 min, opt-in).**

**Why a slow suite exists at all.** Every bug found while building §18.4–18.6
lived in the wiring, not the arithmetic, and none was reachable from a unit test:

| Bug | Where it lived |
|---|---|
| Picking a shipping rate wiped the cart's shipping address | `?? null` in request parsing, turning *absent* into *cleared* |
| "Free over $50" withheld below the threshold **and** charged above it | Two functions each correct alone, disagreeing about one field's meaning |
| The metering base included tax and shipping (D36) | Self-consistent; only `docs/PRICING.md` §4.1 disagreed |
| A rejection's `reason.code` overwrote the shopper's discount code | An object spread in a response body |

The concurrency requirement settles it: `docs/BACKEND.md` §4 demands the
last-unit race be solved with a database transaction, and the only way to
demonstrate that is many simultaneous checkouts through the real server against
real Postgres.

**Tests assert against the database, not through the API that wrote the value.**
Reading a write back through the same code proves only that the code agrees with
itself. The tenancy tests are the clearest case — a refusal is not enough, the
row must be unchanged afterwards.

**Safety, because there is one Supabase project.** "Test database" and "database"
are the same thing today, so the integration suite is gated on an explicit
`MARKII_ALLOW_INTEGRATION_TESTS=1` (set only by `pnpm test:integration`), refuses
a `DATABASE_URL` containing `prod`, and checks the dev server up front. Cleanup
order is fixed once in a `Cleanup` helper rather than at each call site.

**Known cost:** ~10 minutes, because every request is a real round trip to a
remote Supabase through the dev server. Worth revisiting with a local Postgres if
it becomes a reason not to run them — the guard and the helpers would not change.

**Not done, deliberately:** no CI wiring yet (the integration suite needs a
database and a server, which is a separate decision), and no component or
end-to-end browser tests — the frontend has not been built against these
contracts yet.

---

## Email — G1 in full

**Provider: Resend** (owner direction, 2026-07-29). Good fit — first-class Next.js/Vercel DX, React
Email for templates, straightforward domain verification. Nothing below is a reason to reconsider;
they are the decisions Resend does not make for you.

### ✅ Decided: two providers, split by whose mail it is (owner, 2026-07-29)

| | **Resend** — Markii's own identity | **AWS SES** — sent on merchants' behalf |
|---|---|---|
| Sending domain | `markii.shop` only | Each merchant's own domain |
| Volume | Low, flat | Scales with merchants × orders |
| **Carries** | Marketing-site contact form · support correspondence · sales enquiries · staff sign-up, verification, password reset, MFA, invites (via Supabase Auth SMTP) · invoices, dunning, payment failures · platform notices to merchants (threshold warnings, dispute deadlines, plan changes) | Order confirmations · shipping and delivery notices · refund and cancellation notices · **digital delivery: download links and licence keys** · abandoned cart · storefront customer-account mail |
| Why this one | Best DX, React Email templates, low volume, one domain | $0.10/1k (9× cheaper), no meaningful domain cap |

**Never sends merchant mail.** Resend is platform-only, permanently.

### Why the split is better than either provider alone

1. **Reputation isolation becomes structural, not procedural.** This was flagged as the main
   platform-scale email risk and had no good answer under a single provider. Now a merchant's bad
   sending lands on SES and **cannot touch Markii's own password-reset or billing mail on Resend**.
   No policy, no shared-pool management — different infrastructure.
2. **Resend never needs the Scale plan.** The $90/mo, 1,000-domain tier existed solely for
   per-merchant sending domains. With merchant mail on SES, Resend only ever sends from
   `markii.shop`, so **Pro at $20/mo is sufficient indefinitely** — its 10-domain cap is irrelevant.
3. **Cost falls sharply.** At 1,000 merchants: SES ~$25 + Resend Pro $20 = **~$45/mo**, versus
   ~$250–350/mo on Resend Scale alone. The gap widens with every merchant.
4. **Each provider does what it is good at** — SES for cheap high-volume multi-domain sending,
   Resend for templated, low-volume mail where deliverability of a password reset actually matters.

### Verify during build

- **Supabase Auth SMTP is configured per project with a single from-address.** That works for staff
  auth on Resend. **Storefront customer auth is a separate identity domain** (§"Auth — D3" item 4,
  §D32 — same project, isolated by guard rather than by token audience)
  and needs *per-merchant* from-addresses — which Supabase's built-in mailer likely cannot do.
  Expect to send shopper account mail through Markii's own SES path rather than Supabase's mailer.
- **Digital delivery mail is the highest-stakes stream** given the D5 beachhead: a download link in
  a spam folder is a support ticket and a refund. Prioritise SES warm-up, DKIM/SPF/DMARC per
  merchant domain, and dedicated IPs ($15–25/mo) for this traffic before scale.
- **SES sandbox escape needs AWS approval** — start that early, it is not instant.

### ✅ Sending identity: the merchant's own verified domain (owner, 2026-07-29)

Merchant mail sends from **the merchant's own verified domain** — they add SPF/DKIM/DMARC records,
SES verifies, mail comes from them. No `noreply@markii.shop` on customer-facing mail, ever.

**The sequencing problem this creates, and the fix.** Verification requires DNS propagation, so a
merchant who sells before verifying would have an order confirmation fail to send — the worst
possible first impression. Resolve it with the environment split that already exists:

- **Test mode:** send from Markii's domain with the merchant's name and reply-to, clearly labeled
  as test. Lets a merchant build and rehearse immediately.
- **Going live requires a verified sending domain** — a blocking item on the publish checklist,
  beside custom domain and payment setup. A store cannot take real orders it cannot confirm.
- **Ongoing:** monitor DKIM/DMARC health per merchant and alert on breakage, since a lapsed DNS
  record silently kills deliverability. Surface status in the domains settings screen.

This is stricter than the earlier recommendation (which deferred verification until after the first
sale) and it is the right call: it trades a little onboarding friction for never sending a customer
an email that looks like phishing.

### ✅ Supabase Auth SMTP with per-merchant senders — use the Send Email Hook

The problem: Supabase Auth's SMTP is configured **per project with a single from-address**, which
works for staff mail on Resend but cannot produce per-merchant senders for shopper account mail.

**The answer is Supabase's Send Email Hook** (verified 2026-07-29). It *replaces* Supabase's
built-in sending and fires on signup confirmation, password recovery, magic link, email change,
reauthentication, MFA, and identity linking. It hands your handler the **user object (including
metadata)** plus the token/redirect data.

Because **you write the hook**, the from-address is entirely yours to choose — Supabase's docs show
a static example, but nothing constrains it. So:

```
shopper auth event
  → Send Email Hook → your handler
  → read store_id from user metadata
  → render template  → SES, from that merchant's verified domain
```

Store `store_id` in the shopper's user metadata at signup and the hook has everything it needs.

**Two identity domains, two configurations:**

| | Staff auth | Shopper auth |
|---|---|---|
| Supabase project | Main | **Separate project** — hard isolation, satisfies §"Auth — D3" item 4 |
| Email path | Built-in SMTP → **Resend** | **Send Email Hook** → your handler → **SES**, merchant's domain |
| From | `markii.shop` | The merchant's verified domain |

**Watch the MAU cost.** Supabase includes 100k monthly active users; shoppers could exceed that
where staff never will. At 1,000 merchants × ~100 active account-holders that is ~100k MAU — right
at the line; at 10,000 merchants roughly $2,900/mo ($0.29/merchant) at $0.00325/MAU. Not alarming,
but track it, and note that guest checkout keeps most shoppers out of the count entirely. If it
ever turns material, rolling a minimal shopper-account system is the fallback.

**Caveats from the docs:** the hook must return 200; email sending stays disabled if the Email
Provider is disabled regardless of the hook; and Secure Email Change requires sending **two**
emails with specific token/hash pairings — handle that explicitly rather than discovering it in
production.

### Alternatives to Resend — costed 2026-07-29

Markii's email shape is unusual: **bulk transactional sent across thousands of merchant domains.**
Per-email price and per-domain limits dominate; fancy campaign tooling does not (campaigns are
handled by the merchant's own ESP — D27).

| Provider | Cost / 1,000 | Sending domains | Notes |
|---|---|---|---|
| **AWS SES** (à la carte) | **$0.10** | No published cap | **9× cheaper than Resend.** No dashboard, templates, or analytics — you build them. Sandbox escape needs AWS approval. Dedicated IPs $24.95/mo (managed $15) |
| SES Essentials | $0.16 → $0.11 at 100M | " | Tiered plan variant |
| **Resend** (current) | **$0.90** → $0.46 at 2.5M | Pro **10** · **Scale 1,000** ($90/mo) | Best DX, React Email templates, fast to ship |
| **Postmark** | **$1.20–1.80** | Basic 5 · Pro 10 · **Platform unlimited** ($18/mo) | Excellent deliverability, separate transactional/broadcast streams — but the most expensive per email |
| **Loops** | Priced per **contact** | n/a | Built for single-brand SaaS, not multi-tenant sending on merchants' behalf. **Not a fit** |

**Modeled spend** (1,000 merchants × ~250 emails/mo = 250k/mo):

| | Monthly | Annual |
|---|---|---|
| AWS SES | **~$25** | ~$300 |
| Resend Scale | ~$250–350 | ~$3,000–4,200 |
| Postmark Platform | ~$306 | ~$3,700 |

At 10,000 merchants (~2.5M/mo) the gap widens to roughly **$250 vs $1,150 vs $3,000** per month.

### Implementation

**`lib/email/` abstracts both providers behind one interface** — `send()`, template rendering, and
domain registration — with routing by stream, not by call site:

```ts
sendPlatformMail(...)   // → Resend, always from markii.shop
sendMerchantMail(...)   // → SES, from the merchant's verified domain
```

Callers pick the *stream*, never the provider. That keeps the split enforceable in one place, makes
the "Resend never sends merchant mail" rule mechanical rather than a convention, and leaves either
side swappable later.

**Not Postmark** — best-in-class deliverability but the highest per-email cost, and Markii's bulk is
multi-domain transactional. **Not Loops** — contact-based pricing built for single-brand SaaS; it
does not model sending on merchants' behalf at all.

### Also to decide

- **Deliverability posture:** shared vs dedicated sending IPs, and reputation isolation between
  merchants — one merchant sending spammy campaigns must not poison everyone else's order
  confirmations. This is the main platform-scale email risk, and it is the strongest argument for
  moving to SES *before* strictly necessary, since dedicated IPs are cheap there.
- **Marketing vs transactional separation.** Order confirmations are transactional and exempt from
  opt-in rules; abandoned-cart and newsletter mail are **not**. Keep them on separate streams with
  separate consent handling, or risk CAN-SPAM/GDPR exposure on the merchant's behalf. Native
  campaigns are deferred entirely — see **D27**.
- **Template customization.** ✅ Resolved by D27: email templates reuse the **builder's node model**
  with an email-safe render target, never a second template system (`docs/BUILDER.md`).
- **Bounce/complaint handling**, suppression lists, and whether a merchant can see their own
  delivery logs.
- **Volume cost per plan** — email is a real per-order cost at $15/mo pricing.

**Honesty rule that applies here:** never show "confirmation sent" unless the provider accepted the
message, and surface bounces to the merchant rather than silently dropping them.

---

## Remaining gaps resolved (2026-07-29)

### G4 — Support model

**Human escalation on every tier**, including Starter. No bot-only dead ends, no "upgrade to talk to
a person."

| Tier | First response target |
|---|---|
| Starter | 2 business days |
| Growth | 1 business day |
| Scale | 8 business hours |

These are **response targets, not contractual SLAs** — no service credits attached (see G8). State
them as targets publicly so they can be met honestly.

Two things follow from D2's finding that one 15-minute ticket costs ~40% of a month's Starter
revenue: **deflection is the margin lever, not response speed.** Invest in docs, in-product empty
states that explain themselves, and a searchable help centre before headcount. And **route by
severity, not by plan** — a Starter merchant whose checkout is broken outranks a Scale merchant
asking a styling question. Plan tiers should set expectations, not gate urgency.

### G9 — Domain: `markii.shop`

Platform, dashboard, docs, marketing, **and merchant storefront subdomains** all live on
**markii.shop**. Trademark work deferred.

`.shop` resolves the concern raised against the earlier `.dev` candidate: `aurora.markii.shop` reads
as a store to a shopper, so **one domain serves both the platform and storefront subdomains** — no
second domain, one certificate story, one brand. Merchants still bring custom domains on top.

**Code references need updating**: the old domain is hardcoded in `lib/importer.ts`,
`components/dashboard/site-card.tsx`, `components/dashboard/create-website-wizard.tsx`,
`app/page.tsx`, and `app/(dashboard)/dashboard/websites/[slug]/page.tsx`. Fold into the Supabase
migration; **`ROOT_DOMAIN` should drive all of it** rather than string literals, so the next domain
change is a config edit rather than a search-and-replace.

### G2 — Launch countries, and how hard the EU really is

**Launch: US, Canada, UK, Australia. EU as wave 2 — a fast follow, not a deferral.** One currency
per store at launch; multi-currency later.

**The EU is much less hard than it first appears, for one structural reason: Markii is not the
taxpayer.** Under Connect Standard (D4) the merchant owns the Stripe account and sells in their own
name, so **the merchant is the seller of record and liable for their own VAT** — exactly as with
Shopify, Squarespace, and Wix, all of which operate in the EU without being the deemed supplier.
Markii's obligation is to provide correct tooling, not to file returns.

**Stripe Tax already covers the machinery** (verified 2026-07-29): rate calculation across all EU
jurisdictions, precise customer-location evidence, **VAT ID validation with automatic reverse
charge** for B2B, **OSS threshold monitoring**, per-jurisdiction reports, and optional filing
through partners (Marosa for the EU).

So the marginal EU work, once Stripe Tax is wired for US/UK anyway, is small:

- VAT-compliant invoice fields
- VAT number capture in merchant onboarding, with OSS registration guidance
- Surfacing Stripe Tax's reports in the dashboard

**The real costs are not technical:**

1. **Support burden.** Merchants ask tax questions. With a two-person team that is expensive.
   Mitigation: **never give tax advice** — link to Stripe's documentation and tell merchants to
   consult a tax professional, and make that boundary explicit in the help centre.
2. **Legal confirmation that Markii is not a "deemed supplier"/"electronic interface."** The
   precedent is strong (every incumbent operates this way), but the EU's deemed-supplier rules do
   catch some platforms. Cheap to confirm with counsel, expensive to get wrong.
3. **Digital goods have no registration threshold for non-EU sellers** — VAT applies from the first
   sale. A US merchant selling one €10 ebook to a German customer triggers obligations. Markii
   should **warn merchants at the point they enable EU sales**, not silently switch it on.

**Why UK first is deliberate:** post-Brexit UK VAT is the same mechanics in a single jurisdiction —
a clean rehearsal for OSS across 27. Prove the pipeline there, then widen.

### G3 — Sales tax on Markii's own subscription

**Enable Stripe Tax on subscriptions from day one.** Register in jurisdictions as economic nexus
thresholds are crossed rather than pre-emptively. This is Markii's own obligation and is separate
from merchant tax calculation (§18.6).

### G6 — Storefront search

**Postgres full-text search** (`tsvector` + GIN index) over products and content. No separate search
vendor: it is free, it is already in the database, and it is sufficient for a per-store catalog.
Revisit only if relevance complaints appear at scale. Phase C.

Search also helps agents — a `/search?q=` endpoint documented in `agent.md` gives buyer agents a
retrieval path that does not depend on crawling every product page.

### G7 — Cookie consent

**Markii's own storefront analytics are server-side and cookieless** — agent and crawler traffic is
logged from request headers, and there is no cross-site tracking. **No consent banner is required
for Markii's own measurement**, which is a genuine advantage over platforms that ship a tracking
cookie by default.

Merchants who add third-party trackers (GA, Meta Pixel) do need consent. Ship a **consent-banner
block in the builder** that gates third-party scripts, so the merchant's obligation is met with
Markii's component rather than a plugin. Never load merchant-added trackers before consent.

### G8 — Uptime, backups, DR

**No published SLA at launch.** Publishing one is a commitment with financial teeth, and there is no
operating history to base it on. Instead: a **public status page**, **Supabase point-in-time
recovery**, documented **internal RTO/RPO targets**, and incident comms in the dashboard. Offer a
contractual SLA later, with an enterprise tier that is priced for it.

Do not advertise "99.9% uptime" before it has been measured for a year — that is the same
never-imply-what-isn't-true rule applied to marketing.

### G11 — Data residency

**Deferred.** US region at launch. Add an EU region only when a customer contractually requires it,
and treat it as its own project (region-partitioned databases with org-level routing), not as a
config flag. This — not latency — is the thing that would force multi-region, per §D6.

### G12 — Abuse and rate limits

- **Per-org API rate limits**, with headroom well above normal dashboard and MCP use.
- **Storefront fair-use bandwidth** on top of the G5 quotas; throttle rather than hard-cut.
- **Trial abuse:** email verification required, and since no card is taken at signup (D9), pair it
  with per-IP/per-domain signup limits and manual review above a threshold.
- **SES sending caps for new merchants** until sending reputation is established — this protects
  every other merchant's deliverability, which is the shared resource most easily poisoned.
- **Scraping:** storefronts are *meant* to be crawled by agents, so the control is rate limiting and
  bot identification, never blocking. Blocking crawlers would defeat the product.

### Team & launch scope — G10

**Two people: one frontend, one backend (the owner).**

**Phases A–F in full are roughly 9–14 months at this size.** That is a long time without revenue, so
the phase list should not be read as a launch checklist. Define a smaller commercial launch and
sequence the rest behind it.

**The contract-first work already done pays off here.** `docs/API.md` specifies every endpoint, so
frontend and backend can run in parallel from day one instead of the frontend waiting on the
backend. That is the single biggest reason a two-person team can move faster than the phase list
implies.

#### Launch scope — "can a merchant sell and can Markii charge?"

| In | Out (deferred past launch) |
|---|---|
| **A** — auth, orgs, staff, roles | **D** — the site builder (biggest single chunk) |
| **B** — plans, billing, metering, threshold fees | **E** — Channels, Test Lab, full analytics funnel |
| **C** — variants, inventory, cart, checkout, customers, discounts, tax, orders, **digital delivery** | **F** — Chargeback Assist, Agent Ops chat |
| A handful of **polished themes** on the existing storefront renderer | Native campaigns (already D27) |
| **Rule-based readiness score** — the differentiator, cheap to build | |

Roughly **4–6 months** rather than 9–14.

**Deferring the builder is the significant call.** It is the headline feature and mostly frontend
work — but for the D5 beachhead, a creator selling digital products needs a good-looking store far
more than a drag-and-drop canvas. Three or four strong themes cover that, and deferring frees the
frontend engineer for the dashboard surface area that A/B/C actually require. Ship the builder once
there is revenue, and let the action registry (§22) land with it as planned.

**Keep the rule-based readiness score in launch scope** even though it is Phase E. It is cheap
(deterministic rules over catalog data, no inference), and without it Markii launches as a cheaper
Squarespace with no visible differentiator.

#### Work split

| Backend (owner) | Frontend |
|---|---|
| Supabase migration · auth & orgs · billing, metering, threshold engine · commerce core endpoints · Stripe Connect & Tax · SES/Resend · digital delivery | Dashboard screens for A/B/C · checkout UI · storefront themes · billing & threshold meter UI · readiness UI · settings |

**Sequencing risk to manage:** the frontend will outrun the backend early, because screens are
faster to build than payment infrastructure. Absorb the slack with **theme and storefront polish**,
which depends on no API. Conversely, do not let the frontend build against endpoints that do not
exist yet without the contract being agreed first — that is what `docs/API.md` is for, and the
"no mock data" rule keeps the gap visible rather than papered over.

**Re-scope trigger:** if the frontend engineer becomes unavailable, cut to A + B + C with one theme
and no readiness UI. That is still a sellable product; the builder and AI layer are not.

---

## Media gates — G5 (decided: gate per plan)

Wix gates storage (50 GB / 100 GB / unlimited); Markii adopts the same model. **But storage is not
the expensive part — egress is**, and Wix does not gate it explicitly. At Supabase rates,
**$0.125/GB stored versus $0.09/GB delivered**, a single 2 GB course video downloaded 100 times
costs **$18 in bandwidth** — more than a Growth subscription — while sitting in 2 GB of storage
costing $0.25. Gate both, or the gate does nothing.

This matters more than it would otherwise because the **D5 beachhead sells files for a living**.

### Proposed quotas (needs sign-off alongside D1)

| | Starter | Growth | Scale |
|---|---|---|---|
| Media storage | **10 GB** | **50 GB** | **250 GB** |
| Monthly delivery (egress) | **50 GB** | **250 GB** | **1 TB** |
| Storage overage | $0.20/GB | $0.20/GB | $0.20/GB |
| Delivery overage | $0.12/GB | $0.12/GB | $0.12/GB |

Overage carries a modest markup over Supabase's $0.125/$0.09 — enough to cover the cost of heavy
users without becoming a profit centre, consistent with never marking up pass-through costs.

**Honest caveat:** these quotas rely on average consumption, not worst case. A Starter merchant
using every gigabyte would cost ~$5.75/mo against $19 revenue (30%); a Growth merchant at full
quota would cost ~$28 against $49 (57%). That is how all hosting economics work, but it must be
**stated rather than assumed** — and revisited once real usage data exists, because a digital-goods
beachhead skews consumption upward.

### Two architectural requirements that follow

1. **Serve large files with signed URLs directly from Supabase Storage — never proxied through a
   Next.js route.** Proxying pays bandwidth *twice* (Vercel egress **and** Supabase egress) and
   risks function timeouts on large downloads. Signed, expiring URLs also give download-limit
   enforcement for digital delivery for free.
2. **Do not host video.** Course creators will try. Video is the single worst bandwidth profile and
   would break the model quickly. Offer **embed integrations** (Mux, Vimeo, YouTube) instead, so
   video bandwidth sits on a provider built for it. If the beachhead turns out to be video-heavy,
   that is a signal for a dedicated Creator add-on with bandwidth included — not for silently
   absorbing the cost.

**Enforcement:** meter storage and egress per org, surface usage against quota in billing
(alongside the threshold meter), warn at 80%, and never hard-cut a live storefront — throttle or
bill overage instead. Taking a merchant's product downloads offline over a quota is the same
churn mistake as suspending a store during dunning.

---

## Marketing email — D27

"Everything Shopify does except fulfillment" puts campaigns in scope. Here is what Shopify actually
does, and why Markii should not copy it directly.

### Shopify Email — [1P] shopify.com/email + help.shopify.com, 2026-07-29

| | |
|---|---|
| Included | **10,000 emails/month, free, on every plan** |
| Overage | **$1.00 / 1,000** → $0.65 above 300k → $0.55 above 750k |
| Counting | Per **unique recipient** (one send to 800 subscribers = 800) |
| Always free | **Abandoned-checkout automations** — never count toward the allowance |
| Features | Drag-and-drop editor; templates auto-pull store branding, products, prices; automation workflows (triggers, conditions, wait steps); segmentation from customer lists; open/sales/conversion analytics; SMS priced separately |

### Why Markii cannot copy the free tier

10,000 emails costs **~$9/mo at Resend rates** — roughly **47% of a $19 Starter's revenue**.

Shopify affords it because their real income is **2.9% + 30¢ on every order**; email is a
loss-leader funded by payment-processing margin. Markii has deliberately given that up (0% platform
fee, merchant's own Stripe, D4). **The generosity is downstream of the revenue model, and Markii's
revenue model is different.**

> Generalize this: anywhere an incumbent gives something away free, check whether processing margin
> is paying for it. Markii cannot match those giveaways and should not try — it competes on the
> processing economics itself.

### The build is also larger than it looks

Matching Shopify means a segmentation engine, a workflow builder (triggers/conditions/waits), a
template editor, campaign analytics, unsubscribe and consent management, and suppression handling.
That is a product on the order of the site builder. Resend provides sending, not any of that — and
its marketing product is priced per **contact**, a different axis from transactional per-email.

### Operational risk

Marketing email is where sender reputation gets destroyed. One merchant mailing a purchased list
can poison a shared IP pool and take down **everyone's order confirmations**. Shopify has the scale
for dedicated IPs and abuse tooling; Markii will not, initially. This is the strongest argument for
not shipping native campaigns early (see G1 deliverability, G12 abuse).

### Recommendation — three stages

1. **Launch (Phase C): transactional only.** Order confirmations, shipping, refunds, account mail.
   **Include abandoned-cart free**, as Shopify does — it is low volume, the highest-ROI automation,
   and it drives merchant success, which drives retention.
2. **Post-launch: integrate, don't build.** Klaviyo, Omnisend, and Mailchimp are what serious
   merchants already use. Expose them as **Channels** (`docs/API.md` §10) with customer and event
   sync — the architecture already exists, the marginal cost is near zero, and merchants keep the
   tool they know. This is the honest answer to "does Markii do email marketing?"
3. **Later: native campaigns as a paid add-on**, only if demand justifies the build. Price at
   pass-through plus margin with a small included allowance scaled by plan — never a 10,000-email
   free tier.

### Two details worth stealing

- **Abandoned-cart free and uncounted.** Cheap, high-value, and it signals the platform wants the
  merchant to succeed.
- **Templates that auto-pull store branding, products, and prices.** For Markii this must reuse the
  **builder's node model** (`docs/BUILDER.md`) rather than becoming a second template system — same
  blocks, same theme tokens, email-safe render target. Confirms the open question in §G1.

---

## Data architecture — D6 in full

**The question:** is Neon right for a globally distributed platform?

**Short answer:** Neon is fine as the system of record. Global latency is a *caching* problem, not a
database problem — and Markii currently has one specific hot path that makes it look like a
database problem.

### The actual hot path

[`proxy.ts:31`](../proxy.ts#L31) runs on **every request to a custom domain** and issues a blocking
SQL query to resolve host → site slug, before any rendering. On a single-primary Postgres, a shopper
in Singapore pays a trans-Pacific round trip *before the page starts rendering*. This is the single
worst latency offender in the system and it is fixable without changing databases.

**Fix:** move host→slug resolution into an edge-replicated store — Vercel Edge Config (built for
exactly this: tiny, read-heavy, globally replicated config) or a global KV. Write on domain
connect/disconnect; read at the edge in single-digit milliseconds. Postgres stops being on the
request path entirely.

### What actually needs global low latency

| Workload | Latency sensitivity | Answer |
|---|---|---|
| Storefront product/collection/content pages | High — SEO, agents, shoppers | **ISR/PPR + cache tags**, invalidated on publish / price / stock change. Served from CDN edge; DB rarely on the path |
| Host → site resolution | Highest (blocks everything) | Edge Config / KV, as above |
| Cart mutations | Medium | Edge KV or signed cookie, revalidated server-side at checkout |
| Checkout, inventory, orders | Low latency need, **high consistency need** | Primary Postgres. An extra 150 ms at checkout is acceptable; a double-sold item is not |
| Dashboard | Low — merchant sits in one region | Primary Postgres |

Once product pages are cached and host resolution is at the edge, the database is on the critical
path only for cache misses, carts, checkout, and the dashboard — none of which need a globally
distributed write layer.

### Recommendation

1. **Keep Postgres (Neon) as the system of record.** Strong consistency for money, inventory, and
   orders is worth more than globally distributed writes. Commerce is read-heavy and cacheable.
2. **Fix the proxy lookup first** — biggest latency win available, small change.
3. **Cache storefront pages aggressively** with tag-based invalidation on publish/price/stock.
4. **Add read replicas** in 1–2 additional regions only if measurement shows cache-miss reads
   hurting. Measure before adding.
5. **Verify two Neon specifics** against current documentation rather than assumption — this
   register should not encode stale product knowledge:
   - **Scale-to-zero / cold starts.** A cold compute start on a storefront cache miss would be very
     visible. Confirm the plan keeps compute warm.
   - **Current read-replica and multi-region capabilities**, and connection behavior under load.
6. **Revisit only if** a genuine multi-region *write* requirement appears — most likely driven by
   **data residency (G11)**, not latency. If EU data must stay in the EU, the answer is probably
   region-partitioned databases with org-level routing, not a globally replicated single cluster.
   That is a significantly larger project and should be scoped separately.

### Is Supabase cheaper? — **Yes, materially. Recommend switching now.**

Costed 2026-07-29 from both vendors' own pricing pages. Comparing equivalent compute
(~2 cores / 8 GB):

| | **Neon** | **Supabase** |
|---|---|---|
| Compute (2 core / 8 GB, always-on) | Scale: **$324/mo** · Launch: **$155/mo** | Pro $25 + Large $110 − $10 credit = **$125/mo** |
| Storage | **$0.35**/GB-mo | **$0.125**/GB-mo *(2.8× cheaper)* |
| Egress | Not separately published — verify | 250 GB incl., then $0.09/GB |
| **Auth** | Neon Auth (pricing to confirm) | **100,000 MAU included**, then $0.00325/MAU |
| **File storage** | ✗ — needs Vercel Blob | **S3-compatible Storage included** |

**Roughly 2.6× cheaper than Neon Scale on compute, and ~2.8× on storage** — but the bigger win is
consolidation. Supabase absorbs **two other line items**: auth (reversing D3's dependency) and file
storage, which is exactly the **uncosted Vercel Blob line** that D2 flagged as the most plausible way
the margin model breaks. One vendor, one bill, three costs.

**What Neon gives up that is genuinely useful:**

- **Database branching** — excellent with Vercel preview deployments. Real workflow loss.
- **Scale-to-zero and autoscaling** — valuable for spiky or idle workloads, but a shared
  multi-tenant database is always-on by nature, so this advantage mostly does not apply here.
- **No base fee** on Launch.

**Migration cost is near zero today and rises steeply.** The schema is small, there is no production
data, and Drizzle supports both (swap `@neondatabase/serverless` / `neon-http` for `postgres-js` or
`pg`). This is a few hours now versus a migration project after Phase A ships. **If it is going to
happen, it should happen before Phase A.**

**This reverses D3.** Neon Auth was chosen partly because users live in your own Postgres —
Supabase Auth offers the same property with a more mature product (better docs, MFA, SSO, wide
adoption). The coupling between D3 and D6 was flagged when D3 was decided; this is that coupling
coming due, and it resolves in Supabase's favour.

Two things still to verify, and one caveat:

- The **two-isolated-identity-domains** requirement (staff vs storefront customers, §"Auth — D3"
  item 4) applies equally to Supabase Auth. Still the most likely gap.
- Markii authorizes in the **action registry**, not via Postgres RLS, so Supabase's RLS-centric
  patterns are partly moot — use Supabase Auth for identity, keep authorization in `defineAction`.
- Supabase compute resizing **incurs downtime** per their docs; plan scaling windows.

**✅ Decided: Supabase** (owner, 2026-07-29). Sizing assumptions above still need load testing —
treat the figures as directional, not measured.

### Migration plan — Neon → Supabase

**Do this before Phase A.** The schema is small, there is no production data, and seed data is
regenerable. Cost rises steeply once real merchants exist.

**The schema itself does not change.** Both are Postgres and Drizzle supports each — this is a
driver, connection, and services swap, not a data-model rewrite.

| # | Task | Files |
|---|---|---|
| 1 | Swap driver: `@neondatabase/serverless` → `postgres` (postgres.js); `drizzle-orm/neon-http` → `drizzle-orm/postgres-js` | `lib/db/index.ts`, `package.json` |
| 2 | Connection strings: **transaction-mode pooler (6543)** for app queries, **session mode (5432)** for migrations — a pooled connection cannot run DDL | `lib/db/index.ts`, `drizzle.config.ts` |
| 3 | **Fix, don't port, the proxy lookup.** [`proxy.ts:31`](../proxy.ts#L31) queries the DB on every custom-domain request. Replace with Edge Config / KV — the biggest latency win available (see above) | `proxy.ts` |
| 4 | Update seed script connection | `scripts/seed.ts` |
| 5 | Env: `DATABASE_URL` → Supabase pooled URL; add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | `.env.example`, Vercel env |
| 6 | Move migrations to `drizzle-kit generate` + reviewed SQL. **`db:push` stops being safe** once merchants exist | `drizzle.config.ts`, `package.json` scripts |
| 7 | **Auth → Supabase Auth** (D3 reversal). Verify the six requirements in §"Auth — D3" against Supabase instead of Neon Auth | Phase A work |
| 8 | **Uploads → Supabase Storage** (replaces Vercel Blob). The FE treats upload `url` as opaque (`docs/API.md` §4), so **no frontend change is required** — that rule pays off here | `app/api/uploads/`, `docs/API.md` §4 |
| 9 | Configure SMTP for Supabase Auth emails (confirmation, reset) — points at the email provider below | Supabase dashboard |
| 10 | Regenerate seed data; drop the Neon project | — |

**⚠️ Security decision that comes with Supabase: Row Level Security.**

Markii authorizes in the **action registry** (`docs/API.md` §22), not via RLS. Supabase's client
libraries assume RLS because they are designed for direct browser→database access. Markii's
frontend calls `/api/*` only, so the server uses the **service-role key**. Therefore:

- The **service-role key must never reach the browser** — it bypasses RLS entirely. Server-side
  only, never in a `NEXT_PUBLIC_*` variable.
- **Enable RLS on every table anyway**, with deny-by-default policies. It costs nothing and means a
  leaked anon key exposes nothing. Defence in depth, not a substitute for the action registry.
- Do not drift into RLS-based authorization — two authorization systems that disagree is worse than
  either alone. Identity from Supabase Auth; **authorization stays in `defineAction`**.

**What is lost:** Neon's database branching, which was genuinely useful with Vercel preview
deployments. Supabase branching exists but differs — evaluate it during migration and, if it falls
short, use a shared staging project for previews.

### Other alternatives, for completeness

**CockroachDB / Aurora DSQL** — Postgres-wire distributed SQL, true multi-region, at the cost of
write latency, price, and operational complexity. **PlanetScale** — mature horizontal scaling but
MySQL, so the Drizzle schema would be rewritten and Postgres features lost. Turso/D1-style edge
SQLite is a poor fit for transactional commerce needing strong consistency.

None of these fix the proxy lookup, and all are more work than caching. **Do the caching first,
then measure** — that guidance holds regardless of which Postgres vendor wins.

---

## Resolved

*(Record decisions here as they're made: ID, date, decision, and which docs were updated.)*

| ID | Date | Decision | Docs updated |
|---|---|---|---|
| G1 (partial) | 2026-07-29 | **Resend** as the transactional email provider. Sending-identity, deliverability, and consent-separation sub-decisions remain open — see §"Email — G1 in full" | `docs/DECISIONS.md`, `docs/PLAN.md` §4 |
| D3 | 2026-07-29 | **Supabase Auth** (superseded Neon Auth via D6). Six verifications open before Phase A locks — see §"Auth — D3" | `docs/DECISIONS.md`, `docs/PLAN.md` §4, `docs/API.md` §16 |
| D6 | 2026-07-29 | **Supabase** replaces Neon — database, auth, and file storage. ~2.6× cheaper compute, absorbs two other line items. Migration before Phase A; schema unchanged | `docs/DECISIONS.md` §"Data architecture", `docs/PLAN.md` §4, `CLAUDE.md`, `README.md` |
| G1 (provider) | 2026-07-29 | **Two providers, split by whose mail it is: AWS SES** for everything sent on merchants' behalf (orders, digital delivery, shopper mail); **Resend** for Markii's own platform mail only (contact form, support, staff auth, billing). Resend never sends merchant mail — so Pro at $20/mo suffices, not Scale. Makes reputation isolation structural | `docs/DECISIONS.md` §"Email", `docs/PLAN.md` §4, `CLAUDE.md` |
| D1 | 2026-07-29 | **Pricing accepted as proposed** — $15/$39/$99 annual, $19/$49/$129 monthly, thresholds $150k/$750k/$3M, rates 0.5/0.4/0.3%, unlimited seats, 0% digital | `docs/PRICING.md` §3 (already reflects it) |
| D2 | 2026-07-29 | **Margin check passed** — ~87% gross margin at 1,000 merchants, ~69% at 100. D1 holds. Watch items: Blob costs (G5), fair-use bandwidth, support cost (G4) | `docs/DECISIONS.md` §"Unit economics" |
| D4 | 2026-07-29 | **Connect Standard.** Express optional later, unpenalized. Direct API keys dropped (self-hosters bring their own everything). **No platform-negotiated rates** — no leverage, inverts liability, zero upside at 0% platform fee | `docs/DECISIONS.md` §D4, `docs/PLAN.md` §4, `docs/API.md` §8 |
| D26 | 2026-07-29 | **Both** — public source *and* hosted cloud. Largely resolves D15. Self-hosters bring their own infra/payments/DB/auth/email | `docs/DECISIONS.md` §"Distribution" |
| D26-licence | 2026-07-29 | **FSL-1.1-ALv2** — permits self-hosting and contribution, blocks resale-as-a-service, converts to Apache 2.0 after 2 years. Ship with CLA + TRADEMARK.md. **Counsel review before launch** | `docs/DECISIONS.md` §"Distribution" |
| D5 | 2026-07-29 | **Beachhead: creators & digital-goods / membership sellers** (assistant call — owner may override). Fulfillment exclusion becomes irrelevant; Squarespace charges 5% where Markii charges 0%. Adds digital-delivery features to Phase C | `docs/DECISIONS.md` §"Beachhead" |
| G1 (identity) | 2026-07-29 | **Merchant mail sends from the merchant's own verified domain.** Test mode may use Markii's domain; **a verified domain is required to go live**. Shopper auth mail routes through Supabase's **Send Email Hook** → SES, with the sender chosen per merchant from user metadata. ~~Shoppers live in a separate Supabase project~~ — **superseded by D32** | `docs/DECISIONS.md` §"Email", `docs/PLAN.md` §4 |
| D32 | 2026-07-31 | **One Supabase project for staff and shoppers**, reversing G1-identity's split. The single-from-address argument was overstated (the Send Email Hook already solves it); joinable `auth.users` and a smaller operational surface win. Three binding mitigations: membership-lookup authorization, host-only cookies, explicit `user_kind`. Does not bind until §18.3 ships | `docs/DECISIONS.md` §"Identity isolation — D32", §D30, `CLAUDE.md`, `docs/API.md` §16/§18.3, `docs/PLAN.md` |
| G5 | 2026-07-29 | **Media gated per plan — storage *and* egress** (10/50/250 GB stored; 50/250 GB/1 TB delivered), overage $0.20 / $0.12 per GB. Signed URLs direct from storage; **no video hosting** — embeds instead | `docs/DECISIONS.md` §G5, `docs/PRICING.md` §3 |
| D27 | 2026-07-29 | **No native campaigns at launch** — integrate Klaviyo/Omnisend/Mailchimp as Channels; abandoned cart free and uncounted; native campaigns a later paid add-on | `docs/DECISIONS.md` §D27, `docs/PLAN.md` §3 |
| G2 | 2026-07-29 | **Launch US, CA, UK, AU.** EU deferred until Stripe Tax handles VAT OSS — digital goods make EU VAT non-trivial. One currency per store | `docs/DECISIONS.md` §"Remaining gaps" |
| G3 | 2026-07-29 | **Stripe Tax on Markii's own subscriptions from day one**; register as nexus thresholds are crossed | " |
| G4 | 2026-07-29 | **Human escalation on all tiers.** First response 2 business days / 1 business day / 8 business hours. Targets, not SLAs. Route by severity, not plan | " |
| G6 | 2026-07-29 | **Postgres full-text search**, no separate vendor. Also exposed to agents via `agent.md` | " |
| G7 | 2026-07-29 | **Cookieless server-side analytics — no consent banner needed for Markii's own measurement.** Consent-banner builder block gates merchant-added third-party trackers | " |
| G8 | 2026-07-29 | **No published SLA at launch.** Status page, Supabase PITR, internal RTO/RPO. Contractual SLA only with a later enterprise tier | " |
| G9 | 2026-07-29 | **markii.shop.** Trademark deferred. `.dev` forces HTTPS everywhere; consider a separate consumer-facing domain for storefront subdomains; `markii.shop` literals in 5 code files need replacing with `ROOT_DOMAIN` | " |
| G11 | 2026-07-29 | **Data residency deferred** — US region at launch, EU only on contractual demand, as its own project | " |
| G12 | 2026-07-29 | Per-org API rate limits, storefront fair-use throttling, signup verification + limits, **SES sending caps for new merchants**, and rate-limiting (never blocking) for crawlers | " |
| D28 | 2026-07-29 | **POS / in-person retail: deliberate no.** Not a deferral — do not design the data model or roadmap around it. Revisit only if the market forces it, and not soon | `docs/PLAN.md` §3 |
| G9 (revised) | 2026-07-29 | Domain is **markii.shop** — serves platform *and* storefront subdomains, so no second domain is needed | `docs/DECISIONS.md` §G9, all docs |
| G2 (revised) | 2026-07-29 | **EU is a fast follow, not a deferral.** Merchant is seller of record (Connect Standard) so Markii is not the taxpayer; Stripe Tax covers rates, location evidence, VAT ID validation, reverse charge, and OSS monitoring. Real costs are support load and a legal check on deemed-supplier status | `docs/DECISIONS.md` §G2, `docs/PLAN.md` §3 |
| G10 | 2026-07-29 | **Two people (1 FE, 1 BE).** Launch scope cut to **A + B + C + themes + rule-based readiness** (~4–6 months); builder, Channels/Test Lab, and add-ons deferred past launch | `docs/DECISIONS.md` §G10, `docs/PLAN.md` §7 |
| D29 | 2026-07-30 | **Launch storefront themes on the fixed renderer** via Site.`themeId` (`studio` \| `atlas` \| `noir` \| `bloom`, default `studio`). Distinct from Phase D `/api/themes` builder tokens. Preview payloads accept the same field. | `docs/API.md` §Entities/§2, `docs/FRONTEND.md` step 1 |
| D30 | 2026-07-30 | **Auth mutations are server-side only.** Sign-in/up/out/reset run in `/api/auth/*` route handlers via `createServerClient`; cookies are set server-side with `httpOnly`. No `createBrowserClient` in the dashboard. Resolves the ambiguity in D3 item 1 that produced a browser-client sign-in — see §"Session transport — D30" | `docs/DECISIONS.md` §"Session transport", `docs/API.md` §16, `docs/BACKEND.md` §Phase A, `docs/FRONTEND.md`, `CLAUDE.md` |
| D31 | 2026-07-30 | **Minor-unit formatters derive their exponent from the currency**, never assume 2 decimals. `Organization.currency` (§16) is merchant-set, so JPY/KRW would render 100× wrong under a hardcoded `/100`. Applies to all new `Minor` fields; legacy `Cents` fields in §1–8 stay USD-shaped | `docs/API.md` §Conventions, `docs/FRONTEND.md` §Known gaps |
| D34 | 2026-08-03 | **Storefront shopper login shipped as the prerequisite for membership gating** (owner chose it over gating downloads only). The two blockers the docs named — no Phase D content model, no Phase B recurring billing — were not the binding one: there was **no shopper identity at all**, so gating would have enforced nothing. Now live: `/_sites/:site/api/auth/*`, a no-JavaScript `/account` page, `user_kind: "customer"` in `app_metadata`, staff refused at storefront sign-in, and authorization resolving through the per-store `customers` row. **Membership status is derived, never stored** — nothing schedules jobs, so a stored status would outlive its expiry. Memberships do **not** auto-renew | `docs/API.md` §18.9/§18.3, `docs/BACKEND.md` §4, `CLAUDE.md` |
| D33 | 2026-08-03 | **Gift cards deferred until further notice** (owner). Not a scope cut with a date — nothing in §18.5 is to be built, and no schema is to anticipate them. Three prerequisites are recorded so the deferral is reversible without re-deriving them: **split tender** (`provider` is a single enum on `checkout_sessions` and `orders`), a **stored-value ledger** (append-only, like inventory — a balance is not a discount rule), and a **`netSalesMinor` term** (`lib/commerce/orders.ts` has none, so a gift card sold as a product line double-bills and one redeemed as a discount under-bills). Issuance mints value, so it is `riskTier: "high"` when it happens. Expiry/escheatment needs counsel across all four G2 markets **before** any schema | `docs/API.md` §18.5, `docs/PRICING.md` §4.1, `CLAUDE.md`, `docs/BACKEND.md` §4 |
