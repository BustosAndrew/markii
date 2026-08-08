# Markii — Pricing & Billing Spec

Status: **PROPOSED**. Every number in this document is a starting proposal requiring owner
sign-off before it is built, quoted, or published. The *structure* is the recommendation; the
*values* are placeholders.

---

## 1. Principles

1. **Cheaper monthly than the incumbents** at every comparable tier — verified against real
   published pricing, not assumed (`docs/COMPETITORS.md`).
2. **No penalty for bringing your own payment provider — ever, on any plan.** This is the core
   differentiator: Shopify charges up to 2% and BigCommerce up to 2% for exactly this, from the
   first sale.
3. **No Markii transaction fee below the threshold.** Below it the only per-sale cost is the
   merchant's own processor. **Physical and digital meter separately, each against its own
   threshold** (D37) — a merchant under the line on both pays nothing, even if their combined
   sales exceed it.
4. **Never mark up processor fees.** Stripe's cut is Stripe's, passed through at cost. Markii's cut
   is separate, named, and visible.
5. **No cliffs and no forced upgrades.** Crossing the threshold applies a fee only to sales above
   the line. BigCommerce force-upgrades the plan at its cap; Markii never changes a merchant's plan
   for them.
6. **No surprises.** A merchant sees where they stand against the threshold continuously, with a
   projection — the first time they learn about a fee is not on an invoice.

## 2. What the market actually charges

Verified 2026-07-29 from first-party sources — full table in **`docs/COMPETITORS.md`**.

**The market rate for entry-level ecommerce is $29/mo annual (~$39 monthly).** Squarespace Core,
Wix Core, Shopify Basic, and BigCommerce Core all land within a dollar of it. Every one attaches a
catch:

| Platform | $29-tier catch |
|---|---|
| Shopify Basic | **2%** extra unless you use Shopify Payments; **0 staff accounts** |
| BigCommerce Core | **2%** open-provider fee, and a **$30K GMV cap** that force-upgrades you |
| Squarespace Core | 0% on physical goods but **5% on digital/memberships**; ACH 1% uncapped |
| Wix Core | "Basic" ecommerce tier, 50 GB storage cap, 5 collaborators |

Four findings shape the strategy:

1. **The real pain is processor lock-in.** Shopify charges **2% / 1% / 0.6%** for using a provider
   that isn't Shopify Payments — from the first dollar, no threshold — and BigCommerce matches it.
   Squarespace instead tiers its own card rates (2.9% → 2.5%) by plan. All three make the processor
   a pricing lever. A Shopify Basic merchant doing $200K/yr on Stripe pays ~**$4,000/year** for that
   choice alone.
2. **"No transaction fee" is not, by itself, a differentiator.** Squarespace charges 0% on physical
   goods from Core ($29/mo). Messaging built only on fee-free selling reads as parity.
3. **Digital goods are genuinely underserved.** Squarespace taxes digital content and memberships
   at **7% / 5% / 1% / 0%** — a creator pays 5% at $29/mo and must reach **$99/mo** to escape it.
   No competitor prices digital separately. 0% on digital below the threshold is a sharp, narrow,
   verifiable claim with an obvious audience.
4. **Threshold pricing exists, done badly.** BigCommerce caps trailing-12-month GMV at $30K/$100K
   and **force-upgrades** on crossing — validating the trailing-12-month basis while leaving the
   opening wide: a high threshold, a marginal fee, and no forced upgrade.
5. **The headline card rate hides the real cost.** Squarespace's premium-card rate is a flat
   **3.2% on every plan** — it never improves — and ACH is 1% with a $10 cap only at $99/mo, versus
   Stripe's **0.8% capped at $5**. On a $5,000 B2B invoice that is $50 vs $5. Merchants comparing
   platforms see only the headline rate; showing the full stack is both honest and advantageous.
   *Note:* international (+1.5%) and conversion (+1%) surcharges are card-network costs, identical
   on Stripe — Markii must never imply an edge there.

**So the positioning is:** *bring your own payment provider with no platform fee, sell digital goods
without a cut, and never get force-upgraded when you grow.* That attacks where Shopify and
BigCommerce actually extract money and where Squarespace actually hurts creators — rather than
fighting anyone on headline subscription price alone.

## 3. Plan structure (PROPOSED)

Priced against the verified table. The market clusters at $29 annual / $39 monthly for entry
commerce and $79–105 for mid-tier; Markii undercuts both, hardest in the middle.

| | **Starter** | **Growth** | **Scale** |
|---|---|---|---|
| Annual (per mo, billed yearly) | **$15** | **$39** | **$99** |
| Monthly | **$19** | **$49** | **$129** |
| Storefronts | 1 | 3 | 10 |
| Staff seats | **Unlimited** | **Unlimited** | **Unlimited** |
| Media storage | 10 GB | 50 GB | 250 GB |
| Monthly delivery (egress) | 50 GB | 250 GB | 1 TB |
| **Markii fee threshold** (trailing 12-mo net sales, **counted separately for each class**) | $1k | $50k | $100k |
| **Fee above threshold — physical goods** | 1.5% | 0.5% | 0.25% |
| **Fee above threshold — digital goods & memberships** | 3% | 1.5% | 0.5% |
| **Platform fee on any payment provider** | **0%** | **0%** | **0%** |
| Site builder, custom code, agent-native editing | ✅ | ✅ | ✅ |
| **API + MCP access** | ✅ | ✅ | ✅ |
| AI legibility layer (readiness, channels, test lab) | ✅ | ✅ | ✅ |
| Dispute inbox | ✅ | ✅ | ✅ |
| Chargeback Assist add-on | available | available | included |
| Agent Ops add-on | available | available | available |
| Support — first response | 2 business days | 1 business day | 8 business hours |

**Add-ons (PROPOSED):** Agent Ops $29/mo + metered usage above a monthly action allowance;
Chargeback Assist $19/mo; extra storefront $9/mo.
**Media overage:** $0.20/GB stored, $0.12/GB delivered — a modest markup over cost, never a profit
centre (`docs/DECISIONS.md` §G5).

Reasoning behind each number:

- **Starter $15 annual / $19 monthly** undercuts Squarespace Basic ($19/$25) — which also charges a
  **2% store fee and 7% on digital** — and comes in at roughly half the $29 market rate for a
  fee-free commerce tier.
- **Growth $39 annual / $49 monthly** is half of Shopify Grow ($79/$105) and BigCommerce Growth
  ($79/$105), and undercuts Squarespace Plus ($49/$65) while carrying no digital-goods fee.
- **Scale $99 annual / $129 monthly** is one third of Shopify Advanced ($299/$399) and matches
  Squarespace Advanced ($99) at a lower monthly ($129 vs $139).
- **Unlimited seats on every plan.** Squarespace and BigCommerce already do this, so it is clearly
  viable; Shopify (0 / 5 / 15) and Wix (5 / 10 / 100) gate hard. Matching the generous half of the
  market costs little and beats the other half visibly — Shopify Basic includes **zero** staff
  accounts. This correctly kills the per-seat add-on.
- **Full commerce feature set on every plan.** Wix sells "Basic / Standard / Advanced" ecommerce
  and tiers storage; Squarespace withholds 0% digital fees until $99/mo. Refusing to feature-gate
  is a simpler story, easier to keep honest, and removes the most common reason merchants feel
  nickel-and-dimed.
- **API and MCP on every plan.** Squarespace Basic ($19/mo) has no API integrations at all. Gating
  programmatic access would also directly contradict the agent-native architecture — if an agent
  can only operate the store on expensive plans, the product isn't agent-native, it's an upsell.
- **Human support on every plan**, with response *targets* (not contractual SLAs) that scale by
  tier. Severity outranks plan: a Starter merchant with a broken checkout is served before a Scale
  merchant with a styling question (`docs/DECISIONS.md` §G4).
- **0% on digital goods, stated as a headline.** This is the one place a competitor's pricing is
  actively punitive (Squarespace: 5% at $29/mo, 0% only at $99/mo) and it targets a definable
  audience — creators, membership sites, digital-product sellers.
- **Thresholds** at $150k/$750k/$3M sit far above BigCommerce's $30k/$100k caps. The threshold
  should feel like a milestone a merchant is proud to hit, not a tripwire.
- **Storefront count is the remaining upsell lever** — defensible because each store carries real
  infrastructure cost, unlike seats.

Design intent: the threshold scales with tier, so a growing merchant's cheapest move is always to
**upgrade the plan**, not to pay fees — but unlike BigCommerce, the upgrade is their choice, never
forced.

### Margin check — ✅ done 2026-07-29

Modeled against fetched vendor rates in `docs/DECISIONS.md` §"Unit economics — D2". **The pricing
holds comfortably:** ~$1.60/mo infra cost per Starter merchant at 1,000 merchants (**≈92% gross
margin** on $19/mo), ~$3.20 at 100 merchants (**≈83%**).

Revised upward from the first pass (87% / 69%) after two infrastructure decisions: **Supabase**
replaced Neon and absorbed the previously uncosted file-storage line, and **email split across SES
(merchant mail) and Resend (platform mail)** kept Resend on its $20 tier while moving bulk volume to
$0.10/1k.

Four consequences that bind the rest of this document:

1. **Below ~200 merchants, fixed costs dominate** (shared database compute is ~$324/mo regardless of
   tenant count). That is a runway question, not a pricing question — do not raise Starter to fix it.
2. **Annual billing is materially cheaper for Markii**, not just discounted for the merchant:
   Stripe's 30¢ fixed fee makes a $19 monthly charge cost ~4.5% of revenue versus ~3.8% annually.
   Push annual harder than a standard "save 20%" nudge.
3. **The AI legibility layer must stay rule-based** on included plans. Live inference per product
   per merchant would exceed every other cost line combined. Metered inference belongs in Agent Test
   Lab and the Agent Ops add-on, where it is separately paid for.
4. **Support, not infrastructure, is the margin risk.** One 15-minute ticket costs roughly 40% of a
   month's Starter revenue — about 3× the entire infra bill. Self-serve onboarding is the margin
   lever.
5. **Markii can never absorb payment processing.** Stripe's fees run 9–70× per-merchant subscription
   revenue (`docs/DECISIONS.md` §D4), and platform-borne chargeback liability would erase decades of
   a merchant's subscription in a single incident. This is the arithmetic behind staying out of the
   payment flow entirely — it is a survival constraint, not a preference. Bounded acquisition promos
   ("first $1,000 in fees on us", ~$29 once) are the only affordable form.

**Media is now gated** (`docs/DECISIONS.md` §G5) — storage *and* egress, since egress is the
expensive half and the digital-goods beachhead makes file delivery a core workload. Two rules follow
from it: serve large files via **signed URLs directly from storage** (proxying through Next.js pays
bandwidth twice), and **do not host video** — offer Mux/Vimeo/YouTube embeds instead.

Quotas assume average consumption, not worst case: a Starter merchant using every gigabyte would
cost ~$5.75/mo against $19 revenue. That is normal hosting economics, but it is an assumption to
**re-check against real usage**, not a proven number.

### Claim discipline

Comparisons are factual claims Markii owns publicly. Every one ships with a verification date,
re-checked quarterly, sourced from the vendor's own page — never from memory and never from an AI
assistant's recollection. `docs/COMPETITORS.md` lists what is currently defensible and what is not.

## 4. The threshold fee engine

### 4.1 What counts — "net sales"

Precision here is a trust issue. Define once, apply everywhere, show the formula in the UI.

```
net_sales = sum(order line item totals)
          + membership renewals (§18.9 — recurring revenue with no order)
          − discounts
          − refunds (credited in the period the refund occurs)
          − chargebacks lost
excludes: taxes, shipping charges, gift-card purchases (counted on redemption),
          tips, test-mode orders, cancelled/failed/unauthorized orders
```

- **Membership renewals count, and they have no order** (decided 2026-08-07). A recurring
  membership is a Stripe subscription on the merchant's own account, so Stripe bills it on its own
  schedule and no checkout happens — there is no order to sum. It is still revenue the merchant
  received, so a renewal writes a `usage_record` with a **null `order_id`** on `invoice.paid`.
  Excluding it would understate the threshold and undercharge Markii; inventing an order to carry it
  would put rows in `orders` that no shopper placed and that every order screen would then have to
  explain. Renewals meter as **digital** (D39), keyed `renewal:{invoiceId}` so a redelivered webhook
  cannot double-count, and on the **tax-excluded** invoice figure like every other line above.

- **Currency:** normalize to the org's billing currency at the settlement-date rate; store both the
  original amount and the converted amount with the rate used.
- **All rails count** — Stripe, PayPal, card, x402/USDC. The threshold is about merchant size, not
  which rail they chose. Charging differently by rail would contradict rail neutrality.
- **Test/sandbox orders never count.** Enforced at write time, not filtered at read time.

### 4.2 Basis — trailing 12 months (recommended)

Evaluated on a rolling 12-month window, recomputed at each billing period close.

- *Why not calendar year:* every January every merchant resets to zero, which is a large,
  self-inflicted revenue cliff for Markii and a strange experience for merchants.
- *Why not plan-anniversary year:* merchants game it by re-subscribing, and support has to explain
  two different year concepts.
- *Trade-off to accept:* a merchant can drop back below the threshold as a big month ages out.
  That is correct behavior — they got smaller — and it should be visible in the meter.

### 4.3 Fee application — marginal (recommended)

At each monthly close:

```
T12          = trailing 12-month net sales (as of period end)
threshold    = plan threshold
period_sales = net sales in this billing period

excess_at_end   = max(0, T12 − threshold)
excess_at_start = max(0, (T12 − period_sales) − threshold)
billable        = min(period_sales, excess_at_end − excess_at_start)

markii_fee = round_half_even(billable × plan_rate)
```

`billable` is the portion of *this period's* sales that sits above the line — so the month a
merchant crosses, only the sliver past the threshold is charged, never the whole month and never
retroactively.

**Worked example** (Growth, $750k threshold, 0.4%): merchant enters the month at $730k T12 and
sells $60k. `excess_at_end = 40k`, `excess_at_start = 0`, `billable = 40k`, fee = **$160**. The
first $20k of that month is still free.

For scale: the same merchant on **Shopify Grow** using Stripe would pay 1% on *all* $60k — **$600**
that month, every month, with no threshold at all. That contrast is the product.

### 4.4 Adjustments and edge cases

| Case | Handling |
|---|---|
| Refund after fee assessed | Credit the fee on the next invoice at the rate originally charged; never claw back mid-period |
| Chargeback lost | Same as refund — reduce net sales and credit the fee |
| Chargeback won | No adjustment (sale stands) |
| Plan upgrade mid-period | New (higher) threshold applies from the change date; prorate the subscription, not the threshold |
| Plan downgrade | New threshold applies at next period start, never retroactively |
| Cancellation | Assess final period on close; no exit fee |
| Trial | Subscription free; **fees still accrue and display**, invoiced only after conversion. A merchant doing $1M during a free trial is not free |
| Product class | Every metered event carries `physical` or `digital`, frozen at write time from whether the product delivers a file (§18.8) or confers a membership (§18.9). Reclassifying later must never move money between thresholds retroactively |
| Multi-store org | Threshold is **per organization**, aggregated across stores — otherwise splitting stores becomes a fee-avoidance loophole |
| Currency swing | Rate locked at settlement date, stored per order; never retro-recompute |
| Backdated/imported orders | Excluded from metering by default; flag `origin: "imported"` |

### 4.5 Metering implementation

- Write an immutable **usage record** per qualifying order event (sale, refund, chargeback) at the
  moment it happens: `{ orgId, orderId, type, amountMinor, currency, convertedMinor, rate, occurredAt, environment }`.
- Never compute fees from a live join over the orders table — orders mutate, ledgers must not.
- Nightly rollup job maintains `t12_net_sales` per org for the meter; period close recomputes from
  records (authoritative), and reconciles against the rollup with an alert on drift.
- Every invoice line links to the records that produced it. A merchant asking "why this number"
  gets an exact answer.
- Idempotency keys on every write — Stripe webhooks retry.

## 5. Subscription billing

- **Processor:** Stripe Billing for subscriptions and invoices; Stripe Connect for merchant payouts.
  Markii never holds merchant funds (see `docs/PLAN.md` §3 — money transmission).
- **Threshold fees** bill as metered/invoice-item lines on the merchant's Markii subscription
  invoice — not deducted from their payouts. Deducting from settlement would make Markii a party to
  merchant funds flow.
- **Trial:** 14 days, no card required (PROPOSED). Fee accrual visible but not charged.
- **Dunning:** retry schedule, in-app banner, email sequence, then a defined restriction ladder —
  **storefronts stay live** through dunning; restrict dashboard writes and new publishes first.
  Taking a paying merchant's store offline over a failed card is a churn event, not a collection
  strategy. Hard suspension only after the full ladder.
- **Invoices:** downloadable PDF, line-itemized (subscription, add-ons, threshold fee with the GMV
  math shown, credits), plus tax on the subscription itself where applicable.
- **Entitlements:** a single typed `entitlements` object drives every gate (store count, seats,
  add-ons, threshold). Screens check entitlements, never plan names — plans change, capabilities
  are stable.

## 6. Merchant-facing UI

**Billing page** (`/dashboard/settings/billing`):
- Current plan, renewal date, payment method, invoice history.
- **Threshold meter** — the centerpiece. Trailing-12-month net sales against the plan threshold, a
  projection to period end, and, once past it, fees accrued this period with the formula expanded.
- Explicit separation: *"Payment processing fees are charged by your provider (Stripe) and are not
  part of your Markii bill."* Show them side by side so the total cost of a sale is honest.
- **Total-cost calculator** (`docs/COMPETITORS.md`): takes the merchant's real mix — ticket size,
  digital vs physical, card mix, ACH share, international share, annual volume — and shows annual
  cost on Markii versus each competitor, counting the fees the incumbents bury (premium-card rates,
  ACH pricing, digital-goods fees, processor penalties). It must be willing to show cases where
  Markii is *not* cheapest; a calculator that always says "choose us" is marketing, and merchants
  can tell.
- Upgrade prompt when projected fees exceed the price difference to the next tier — recommending the
  cheaper option for the merchant builds more trust than the extra margin is worth.
- Plan comparison, add-on toggles, cancellation with a clear consequence summary.

**Rules:** the meter renders *not yet measured* rather than `0` before any sale exists; a merchant
in trial sees "would have been charged" framing; never display a projected fee as if it were owed.

**How the fee actually reaches a merchant (implemented).** A closed `fee_assessment` becomes a
Stripe **invoice item**, which Stripe pulls onto that merchant's next subscription invoice as a
named line carrying its own arithmetic — the period, the class, the billable slice, the threshold,
and the rate. It is deliberately not a separate invoice: one relationship should produce one
invoice and one dunning path.

Two consequences fall out of that and are enforced rather than assumed
(`assessmentBillable` in `lib/billing/fee-invoice.ts`):

- **A fee needs a subscription to ride on.** An invoice item raised against a customer with no
  active subscription is never billed and never expires — it silently waits and then attaches to
  whatever invoice appears months later. Markii refuses to create one instead.
- **Only a closed period is billed, and only once.** The period in progress stays a projection, and
  the write is idempotent on the assessment id so a retry cannot raise a second charge.

An assessment marked `invoiced` with **no** invoice item is a real and distinct state: the merchant
was under their threshold and owed nothing, so the period is settled rather than left pending
forever.

## 7. Build order

1. Plans, entitlements, Stripe Billing subscription lifecycle, invoices, dunning
2. Usage records written from the order pipeline (before any commerce launch — retrofitting a
   ledger over historical orders is painful and lossy)
3. Rollups, threshold meter UI, projection
4. Period close, fee assessment, invoice lines, adjustment/credit handling
5. Add-on entitlements (Agent Ops, Chargeback Assist), metered add-on usage

## 8. Open decisions

- All price points, thresholds, and rates in §3 (**blocking**)
- Threshold basis (§4.2) and marginal application (§4.3) — confirm recommendations
- Trial length and whether a card is required
- Whether annual plans get threshold credit for prepayment
- Dunning restriction ladder specifics and grace period length
- Whether Starter's single storefront is genuinely enough for the target merchant
