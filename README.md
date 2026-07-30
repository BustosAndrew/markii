# Markii

**A commerce platform that doesn't tax your growth.** Build a store with drag-and-drop, sell to real
shoppers, and **bring your own payment provider with no platform fee** — Shopify and BigCommerce
charge up to 2% for exactly that, and Squarespace takes 5% of digital sales until you're paying
$99/mo ([verified](docs/COMPETITORS.md)). No Markii transaction fee at all until you cross an annual
sales threshold, then only on the portion above it, with no forced plan upgrade.

Storefronts are semantic HTML with JSON-LD, `llms.txt`, and `agent.md` out of the box, so AI
shopping agents can read, recommend, and buy from them — with an Agent Readiness Score telling you
how well.

And the admin is **agent-native**: every capability is one shared action serving the UI, the API,
and an MCP server alike. Edit your store visually, or point Claude Code at it — same permissions,
same audit trail, same undo.

Everything Shopify does, except fulfillment logistics.

## Status

**v1 is built and running** — dashboard, REST API, multi-tenant storefront renderer, agent-readable
output, x402 checkout, catalog importer, seed data. Needs `DATABASE_URL` in `.env.local`.

**v3 is the plan, not the code.** The platform scope below is specified and contracted, not
implemented. Two gaps matter most: there is **no auth or tenancy** and **no human checkout** yet.

| Phase | Scope | Launch? | Doc |
|---|---|---|---|
| A | Auth, organizations, staff, roles, scoped tokens | ✅ | `docs/API.md` §16 |
| B | Plans, billing, GMV metering, threshold fees | ✅ | `docs/PRICING.md` |
| C | Variants, inventory, collections, customers, cart, checkout, discounts, digital delivery | ✅ | `docs/API.md` §18 |
| — | 3–4 storefront themes · rule-based readiness score | ✅ | `docs/FRONTEND.md` |
| D | Action registry + MCP, then the agent-native site builder | after | `docs/BUILDER.md` |
| E | AI layer: channels, test lab, analytics funnel | after | `docs/API.md` §9–15 |
| F | Chargeback Assist, then the Agent Ops chat add-on (last) | after | `docs/AGENT-OPS.md` |

Launch is a deliberate subset — the team is two people (`docs/DECISIONS.md` §G10). Check the status
legend at the top of [docs/API.md](docs/API.md) before calling any endpoint.

## Start here

| You are… | Read |
|---|---|
| **Building screens** | **[docs/FRONTEND.md](docs/FRONTEND.md)** → `CLAUDE.md` → `docs/API.md` status legend → `DESIGN.md` |
| **Building the API, DB, auth, billing** | **[docs/BACKEND.md](docs/BACKEND.md)** → `CLAUDE.md` → `docs/API.md` → `docs/DECISIONS.md` |
| **An AI agent in this repo** | `CLAUDE.md` first — it is binding |
| **Deciding product direction** | `docs/PLAN.md` → `docs/DECISIONS.md` → `docs/COMPETITORS.md` |

## Stack

- **Next.js 16** (App Router, Turbopack) · React 19 · TypeScript
- **Tailwind CSS 4** + [motion](https://motion.dev) · lucide-react icons
- **Supabase** — Postgres, auth, file storage · **Drizzle ORM** · zod · schema-dts for JSON-LD
- **AWS SES** — merchant-facing email · **Resend** — Markii's own platform mail *(planned)*
- **Stripe** — subscriptions, Connect Standard, hosted checkout *(planned)*
- **@x402/core + viem** — agent payments on Base Sepolia
- **cheerio** — catalog import fallback · **@vercel/sdk** — custom domains
- **googleapis** — Google Merchant Center

## Quickstart

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # production build
pnpm lint
pnpm db:push    # push Drizzle schema (dev only)
pnpm db:seed    # seed demo data
```

Storefronts are reachable in dev at `http://localhost:3000/_sites/{siteSlug}/…`.

## Structure

```
app/
  page.tsx           # Marketing landing
  (dashboard)/       # Merchant admin
  api/               # REST API (contract: docs/API.md)
  %5Fsites/[site]/   # Multi-tenant storefronts — must stay %5F-escaped (see CLAUDE.md)
components/          # UI primitives + dashboard components
lib/                 # db/, api client, importer, x402, generators, integrations
docs/
  FRONTEND.md        # Frontend start-here: scope, build order, rules
  BACKEND.md         # Backend start-here: scope, build order, traps
  PLAN.md            # v3 direction, launch subset, phases
  DECISIONS.md       # Decision register — every settled call, with reasoning
  API.md             # API contract with LIVE/PLANNED status legend
  PRICING.md         # Plans, threshold fee engine, billing UX
  COMPETITORS.md     # Verified competitor pricing (sources + dates)
  BUILDER.md         # Agent-native site builder architecture (post-launch)
  AGENT-OPS.md       # Ops agent add-on (chat ships last)
CLAUDE.md            # Working rules for agents
DESIGN.md            # Design tokens and visual rules
PRODUCT.md           # Users, positioning, principles
```

## Notes

Pricing figures in `docs/PRICING.md` are **proposals pending sign-off**. Competitor figures in
`docs/COMPETITORS.md` were verified 2026-07-29 and must be re-checked quarterly and before any
public comparison ships — a stale price claim is a false one.
