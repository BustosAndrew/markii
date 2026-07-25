# Markii

**Storefronts built for AI buyers.** Markii is an agent-native, multi-tenant commerce platform:
import a catalog, and it provisions machine-readable storefronts (plain HTML + JSON-LD,
`llms.txt`, `agent.md`) that AI agents can crawl, understand, and pay — in USDC over the
[x402](https://www.x402.org/) protocol on Base Sepolia.

## Status

🚧 4-hour hackathon build. **Landing page only** so far — the `Open Dashboard` button points at
`/dashboard`, which is next up. Full scope and timeline live in [docs/PLAN.md](docs/PLAN.md).

## Stack

- **Next.js 16** (App Router, Turbopack) · React 19 · TypeScript
- **Tailwind CSS 4** + [motion](https://motion.dev) for animations · lucide-react icons
- **Drizzle ORM + Neon Postgres** (planned)
- **@x402/core + viem** — agent payments (planned)
- **@vercel/sdk** — custom domains · **googleapis** — Google Merchant Center (planned)
- **Stripe** — optional fiat rail (planned)

## Quickstart

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # production build
pnpm lint
```

## Structure

```
app/
  page.tsx          # Landing page (built)
  layout.tsx        # Root layout, fonts, metadata
  icon.svg          # Favicon (brand logo)
components/
  logo.tsx          # Gradient bag-bot logo
docs/
  PLAN.md           # Full build scope + 4-hour timeline
```
