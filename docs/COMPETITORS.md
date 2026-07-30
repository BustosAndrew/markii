# Competitor Pricing — Verified Reference

**Verified: 2026-07-29.** Re-verify quarterly and before any public comparison ships. Pricing on
these platforms changes without notice; a stale claim is a false claim.

Source quality matters here — figures are tagged **[1P]** (from the vendor's own site) or **[3P]**
(third-party aggregator). Never publish a 3P figure without confirming it against the vendor page
first: on 2026-07-29 the aggregators' Squarespace annual prices were wrong by $10/mo at entry, and
were corrected only when the real pricing page was seen directly.

---

## Shopify — [1P] shopify.com/pricing, 2026-07-29

| Plan | Monthly | Annual (per mo) | Staff | Shopify Payments card rate | **Fee if you use another processor** |
|---|---|---|---|---|---|
| Basic | $39 | $29 | 0 | 2.9% + 30¢ | **2.0%** |
| Grow | $105 | $79 | 5 | 2.7% + 30¢ | **1.0%** |
| Advanced | $399 | $299 | 15 | 2.5% + 30¢ | **0.6%** |
| Plus | from $2,300 | — | Unlimited | best available | **0.2%** |

Promo at time of check: 3 days free, then $1/month for 3 months.

**The key structural fact:** Shopify's "transaction fee" is a **penalty for not using Shopify
Payments**. Use their processor and the platform fee is 0%; use Stripe and you pay 2% on Basic —
on top of Stripe's own ~2.9% + 30¢. No GMV threshold; the penalty applies from the first sale.

## Squarespace — [1P] squarespace.com/pricing, 2026-07-29 (owner-supplied screenshots)

| Plan | Annual (per mo) | Monthly | Online store fee | Digital/memberships fee | Card rate | Contributors |
|---|---|---|---|---|---|---|
| Basic | **$19** | **$25** | **2%** | **7%** | 2.9% + 30¢ | 2 |
| Core | **$29** | **$39** | **0%** | **5%** | 2.9% + 30¢ | Unlimited |
| Plus | **$49** | **$65** | **0%** | **1%** | 2.7% + 30¢ | Unlimited |
| Advanced | **$99** | **$139** | **0%** | **0%** | 2.5% + 30¢ | Unlimited |

### Squarespace full payment cost table [1P]

The headline card rate is not the whole cost. Every row below is charged by Squarespace:

| Cost | Basic | Core | Plus | Advanced |
|---|---|---|---|---|
| Standard cards | 2.9% + 30¢ | 2.9% + 30¢ | 2.7% + 30¢ | 2.5% + 30¢ |
| **Premium cards** | **3.2% + 30¢** | **3.2% + 30¢** | **3.2% + 30¢** | **3.2% + 30¢** |
| **ACH** | **1.5%** | **1%** | **1%** | 1% ($10 max) |
| International card surcharge | +1.5% | +1.5% | +1.5% | +1.5% |
| Currency conversion | +1% | +1% | +1% | +1% |
| Online store fee | **2%** | 0% | 0% | 0% |
| Digital/memberships fee | **7%** | **5%** | **1%** | 0% |
| Pay Links | Unlimited | Unlimited | Unlimited | Unlimited |
| POS processor | ✅ | ✅ | ✅ | ✅ |

Feature gating: Basic gets products, free invoices, and content/memberships. **Core and above add
professional shipping and tax services, sales funnel analytics, and — notably — API integrations.**
Basic has no API access at all. Core+ also adds advanced analytics, **complete CSS/JavaScript
customization**, and Google Workspace email. Free custom domain is **annual-billing only** (struck
through on monthly).

Two costs never improve with plan tier: **premium cards stay at 3.2%** no matter how much you pay,
and the international/conversion surcharges are flat across all four plans.

### Stripe direct, for comparison — [1P] stripe.com/pricing, 2026-07-29

| Cost | Stripe standard US |
|---|---|
| Domestic cards | 2.9% + 30¢ |
| International cards | +1.5% |
| Currency conversion | +1% |
| **ACH** | **0.8%, capped at $5** |
| Manually entered cards | +0.5% |
| Premium-card surcharge | none published |

**Read this honestly.** International and conversion surcharges are card-network costs and are
identical on both — not a differentiator, and Markii should never imply otherwise. Two real gaps
do exist:

- **ACH.** Stripe 0.8% capped at **$5**; Squarespace 1% with a **$10** cap available only on the
  $99 plan. On a $5,000 B2B invoice that is **$5 vs $50** — a 10× difference that grows with
  ticket size. Relevant to anyone selling services, wholesale, or high-ticket goods.
- **Premium cards.** Squarespace publishes a flat 3.2% for premium cards on every plan; Stripe's
  published standard rate carries no premium-card surcharge. On a rewards-card-heavy customer base
  that is a persistent ~0.3% drag that no amount of plan upgrading removes.

And the structural point: on Markii the merchant holds the Stripe account, so **at volume they can
negotiate rates directly with Stripe** — impossible when the platform owns the processor
relationship.

> **Correction, 2026-07-29.** An earlier revision of this file carried third-party figures of
> $16/$23/$39/$99 annual and $21/$32/$48/$119 monthly. Both were wrong (only Advanced-annual was
> right). Squarespace is **$10/mo more expensive at entry** than the aggregators claimed. The
> monthly figures from one aggregator ($25–$139) happened to be correct; the other's were not.
> This is exactly why 3P figures do not ship — verify from source.

**Three things to note carefully:**
- Squarespace charges **0% store fee from Core ($29/mo annual) upward**. "No transaction fee" is
  *not* a differentiator against them at that tier.
- But **digital goods and memberships are taxed hard**: 7% / 5% / 1% / 0%. A creator selling
  memberships pays 5% at $29/mo and must reach **$99/mo** to escape it entirely.
- Squarespace **tiers card rates by plan** (2.9% → 2.5%), the same lock-in shape as Shopify: the
  processor is theirs, so the rate is a plan lever rather than something a merchant can negotiate.

## Wix — [1P] wix.com, 2026-07-29 (owner-supplied screenshot); monthly figures [3P]

| Plan | Annual (per mo) [1P] | Monthly [3P] | Ecommerce | Storage | Site collaborators |
|---|---|---|---|---|---|
| Light | $17 | $24 | ❌ none | — | — |
| Core | **$29** | $36 | Basic | 50 GB | **5** |
| Business | **$39** | $46 | Standard | 100 GB | **10** |
| Business Elite | **$159** | $172 | Advanced | Unlimited | **100** |

Business Elite adds an "advanced developer platform". Wix gates on **storage** and **ecommerce
feature depth** (Basic/Standard/Advanced) as well as seats. The screenshot shows the annual-billing
view; monthly figures remain 3P and unconfirmed.

## BigCommerce — [1P] bigcommerce.com/essentials/pricing, 2026-07-29

| Plan | Monthly | Annual (per mo) | GMV cap | Open-provider fee |
|---|---|---|---|---|
| Core | $39 | $29 | **$30K TTM GMV → auto-upgrade** | 2.0% |
| Growth | $105 | $79 | **$100K TTM GMV → auto-upgrade** | 1.0% |
| Scale | $399 | $299 | **$33,333/mo, then 0.9% on GMV above cap** | 0.6% |
| Performance | from $1,499 | — | $1M+, custom | none (contracted) |

**Direct precedent for the threshold model** — and instructive. BigCommerce measures **trailing-12-
month GMV** (validating that basis), but crossing a cap **force-upgrades the plan**, and Scale
charges 0.9% above its cap *in addition* to the plan price. Their thresholds are also low: $30K on
the entry plan.

---

## The market's entry price for real ecommerce

Striking convergence at the tier where a merchant first gets a 0%-ish store fee:

| Platform | Plan | Annual/mo | Monthly | Catch |
|---|---|---|---|---|
| Squarespace | Core | $29 | $39 | 5% on digital/memberships |
| Wix | Core | $29 | $36 | "Basic" ecommerce tier, 50 GB, 5 collaborators |
| Shopify | Basic | $29 | $39 | 2% unless you use Shopify Payments |
| BigCommerce | Core | $29 | $39 | 2% open provider, **$30K GMV cap** |

**$29 annual / ~$36–39 monthly is the market rate**, and all four land within a dollar of each
other — this is a settled price point, not a coincidence. That is the number Markii prices against,
and every one of them attaches a catch at it.

## What the data actually says

1. **The real pain is processor lock-in, not transaction fees per se.** Shopify and BigCommerce tax
   you 0.6–2% for using your own payment provider, from the first dollar; Squarespace instead tiers
   its own card rates by plan. All three make the processor a pricing lever. A Shopify Basic
   merchant doing $200K/yr on Stripe pays about **$4,000/year** purely for that choice.
2. **"No transaction fee" alone is not a differentiator.** Squarespace offers 0% store fee from
   $29/mo. Messaging built solely on fee-free selling reads as parity to anyone who has compared.
3. **Digital goods are the underserved niche.** Squarespace charges 7% / 5% / 1% / 0% on digital
   content and memberships — a creator pays 5% at $29/mo and must reach $99/mo to escape it.
   Nobody else prices digital separately. 0% on digital below the threshold is a sharp claim.
4. **Threshold pricing has precedent, done badly.** BigCommerce's caps are low ($30K/$100K) and
   trigger a **forced plan upgrade**. A marginal fee with a genuinely high threshold is a real
   improvement, not a novelty.
5. **The mid-tier is where the money is and the gap is widest.** Shopify Grow and BigCommerce
   Growth are both $79–105/mo. Undercutting there matters more than fighting Squarespace at $19.
6. **Almost everyone gates seats, and Squarespace shows it isn't necessary.** Shopify: 0 / 5 / 15.
   Wix: 5 / 10 / 100. BigCommerce: unlimited. Squarespace: unlimited from $29. So unlimited seats
   on every plan is *achievable* (two competitors already do it) and *visibly better* than the two
   that don't — for revenue Markii would barely miss.
7. **Feature-gating ecommerce depth is common and worth refusing.** Wix sells Basic / Standard /
   Advanced ecommerce and tiers storage; Squarespace withholds 0% digital fees until $99/mo.
   Shipping the full commerce feature set on every plan, and gating only on storefront count, is a
   cleaner story than four-way feature matrices — and easier to keep honest.
8. **API access is a paid upgrade elsewhere.** Squarespace Basic ($19/mo) has **no API
   integrations** at all; they start at Core. For a platform whose thesis is agent-native operation,
   shipping the API **and MCP** on every plan is both a differentiator and a consistency
   requirement — gating it would contradict the architecture.
9. **The headline card rate hides the real cost.** Squarespace's premium-card rate is a flat 3.2%
   that never improves with tier, and its ACH is 1% with a $10 cap only at $99/mo versus Stripe's
   0.8% capped at $5. Merchants comparing platforms look at the headline rate; the honest move is
   to show them the whole stack.

## Defensible claims (as of 2026-07-29)

✅ Sayable, with the verification date attached:
- "Use any payment provider without a platform fee — Shopify and BigCommerce charge up to 2% for
  that, on every sale, from your first one."
- "No transaction fee until you're doing real volume, then only on the portion above it — and we
  never force you onto a higher plan the way BigCommerce does at $30K."
- "0% on digital products and memberships. Squarespace charges 5% at $29/mo and only drops to 0%
  at $99/mo."
- "Unlimited staff seats on every plan. Shopify Basic includes none; Wix Core includes five."
- "API and MCP access on every plan. Squarespace Basic has no API integrations at all."
- "Your Stripe account, your rates — negotiate directly at volume." (Structural fact, not a number.)
- "The full commerce feature set on every plan" — provided Markii actually does this and does not
  later gate features by tier.

❌ Not sayable:
- "Cheaper than everyone at every tier" — check the table before any superlative.
- "The only platform without transaction fees" — Squarespace Core+ is 0% on physical goods.
- **"Lower international or currency-conversion fees."** Those are card-network costs and are
  identical (+1.5% / +1%) on Stripe and Squarespace alike. Claiming an edge here would be false.
- Any competitor figure without a fresh first-party check. **Never quote from memory, from an
  aggregator, or from an AI assistant's recollection** — the 2026-07-29 correction above is what
  that produces.

### Worth building: an honest cost calculator

Every competitor advertises a headline card rate and buries the rest — premium-card surcharges,
ACH pricing, digital-goods fees, store fees, processor penalties. A calculator that takes a
merchant's real mix (ticket size, digital vs physical, card mix, ACH share, international share,
annual volume) and shows total annual cost on each platform would be genuinely useful, hard for
incumbents to copy without exposing their own stacking, and consistent with the product's cost-
honesty principle. It must show cases where Markii is **not** cheapest — a calculator that always
returns "choose us" is marketing, not a tool, and merchants can tell.

## Re-verification

Keep this file as the single source. Store the comparison in the app as data with a `verifiedAt`
field (`docs/API.md` §17, `GET /api/billing/plans`) so the marketing site renders the date it was
last checked rather than a hardcoded number that silently rots.
