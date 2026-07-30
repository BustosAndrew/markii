# Design

<!-- impeccable:design-schema 1 -->

---
name: Markii
description: Light, restrained admin and marketing UI for agentic commerce infrastructure
colors:
  background: "#FAFAFA"
  card: "#FFFFFF"
  card-elevated: "#FCFCFC"
  border: "#E7E7EA"
  border-nav: "#ECECEC"
  hover: "#F3F4F6"
  hover-soft: "#F5F5F7"
  table-hover: "#F8F8F9"
  text-primary: "#16161D"
  text-secondary: "#6B7280"
  text-muted: "#9CA3AF"
  text-disabled: "#C7CBD1"
  brand-primary: "#C9184A"
  brand-hover: "#A4133C"
  brand-pressed: "#800F2F"
  brand-deep: "#590D22"
  brand-mid: "#800F2F"
  brand-rose: "#A4133C"
  brand-bubblegum: "#FF4D6D"
  brand-light: "#FF758F"
  success-bg: "#E8F8F4"
  success-text: "#0A9396"
  warning-bg: "#FFF7E5"
  warning-text: "#EE9B00"
  error-bg: "#FFF0F1"
  error-text: "#C9184A"
  info-bg: "#EEF6FF"
  info-text: "#3A86FF"
  chart-1: "#C9184A"
  chart-2: "#FF758F"
  chart-3: "#800F2F"
  chart-neutral: "#D1D5DB"
  on-brand: "#FFFFFF"
typography:
  sans:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
  mono:
    fontFamily: "var(--font-geist-mono), ui-monospace, monospace"
  display:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  card: "16px"
  control: "12px"
  badge: "999px"
spacing:
  page-x: "24px"
  section-y: "80px"
  card-pad: "24px"
components:
  button-primary:
    backgroundColor: "{colors.brand-primary}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
    textColor: "{colors.on-brand}"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
---

## Overview

Markii’s visual world is **restrained infrastructure UI**: calm light neutrals with a single rose accent that appears only when it means action, AI/status, or brand identity. The feeling is Vercel / Stripe for agentic commerce — premium, technical, trustworthy — not a consumer shop.

Color strategy: **Restrained** (neutrals + one accent). Light mode only. The logo gradient carries brand emotion; the interface stays quiet so the mark and primary actions read clearly.

Modes: **Persuade** on the marketing landing; **Operate** on the dashboard. Same tokens; different density and whitespace.

## Colors

- **Canvas:** `#FAFAFA` page background. Cards `#FFFFFF`. Elevated surfaces `#FCFCFC`.
- **Structure:** Borders `#E7E7EA` (nav bottom `#ECECEC`). Hovers `#F3F4F6` / `#F5F5F7`.
- **Type:** Primary `#16161D`, secondary `#6B7280`, muted `#9CA3AF`, disabled `#C7CBD1`.
- **Brand (scarce):** Primary action `#C9184A` → hover `#A4133C` → pressed `#800F2F`. Logo gradient only: `#590D22` → `#FF758F` (and intermediate stops from the visual plan). Do not wash panels or backgrounds in brand pink.
- **Status badges:** success / warning / error / info as in tokens — error text reuses brand rose.
- **Charts:** `#C9184A`, `#FF758F`, `#800F2F`, neutral `#D1D5DB`.

Rule: every time the user sees color, it should mean action, AI, or status.

## Typography

Geist Sans / Geist Mono (existing Next font setup) for Operate clarity. Hierarchy via weight and size, not decorative display faces. Soft near-black (`#16161D`) over pure black. Mono reserved for protocol snippets, tx hashes, agent user-agents.

## Layout

- Dashboard: fixed sidebar (`#FFFFFF`) + top bar (`#FAFAFA`, bottom border `#ECECEC`, no shadow). Content max-width comfortable for tables; generous page padding.
- Active nav: left (or bottom) border accent `#C9184A` — not a filled pill.
- Landing hero: huge whitespace; logo dominant; one sentence; primary + secondary CTA; almost no color beyond logo and primary button.
- Cards 16px radius; avoid card-for-decoration — use cards for interactive/data containers in Operate mode.

## Elevation & Depth

Prefer flat tonal separation over heavy shadow. Allowed shadows only:

- `0 1px 2px rgba(16,24,40,.04)`
- `0 4px 12px rgba(16,24,40,.05)`

No glow, no multi-layer dramatic shadows.

## Shapes

- Cards: 16px
- Buttons / inputs: 12px
- Badges: full pill (`999px`)
- Focus ring on inputs: brand `#C9184A` at ~10% opacity outer ring

## Components

- **Primary button:** solid `#C9184A`, white label.
- **Secondary:** white + `#E7E7EA` border; ghost: transparent + soft hover.
- **Tables:** header `#FCFCFC`, rows white, hover `#F8F8F9`.
- **Badges:** status palette above.
- **AI affordances** (when contracted): typing/stream/status/avatar ring use `#C9184A` — not ChatGPT green.
- **Empty states:** white / `#FAFAFA` / `#16161D` / logo gradient only.
- **Preview panes:** sandboxed iframe for storefront HTML; monospace panes for `llms.txt` / `agent.md`.

## AI-layer patterns (readiness, channels, test lab)

The PRD directs **reuse** of this visual language — same tokens, same light palette, no redesign.
New surfaces add patterns, not a new look:

- **Readiness score:** single number + five component bars (product data, inventory, policies,
  checkout, protocol coverage). Score band uses the status palette, not a rainbow gradient;
  `#C9184A` for critical, warning amber, success teal. Trend shown as a signed delta, never a
  decorative sparkline without axis context.
- **Severity badges:** Critical → `error-bg`/`error-text`; Warning → `warning-bg`/`warning-text`;
  Opportunity → `info-bg`/`info-text`. Always pair the color with a text label — status is never
  color-only.
- **Channel status:** pill + `status-dot`. `connected` success, `syncing` info, `action_required`
  warning, `error` error, `test_mode` info with an explicit "Test" word, `coming_soon` disabled
  neutral (`#C7CBD1`). Group channels by kind — protocols, marketplaces, feeds, payment rails
  never share a section header.
- **Issue drawer:** right-side drawer (not a modal) so the table stays visible. Evidence rows use
  mono for field names and current values.
- **Steppers:** the 6-step deployment wizard uses a numbered horizontal stepper; completed steps
  get a check, current step brand rose, future steps neutral.
- **Timelines:** order events as a vertical rail with status-colored nodes; timestamps in mono.
- **Tabs:** product detail (Basic Information · Commerce · Agent Data · Channel Preview · Health)
  uses underline tabs with the active underline in `#C9184A`.
- **Environment labeling:** any test/sandbox/demo surface carries a persistent visible badge.
  A global Demo Mode indicator sits in the top bar when demo data is ever introduced. Never rely
  on tone alone to signal "this isn't real".
- **Unmeasured data:** render an em dash with a "not yet measured" label in `text-muted` — never a
  `0`, never a flat placeholder chart.

## v3 patterns (commerce platform)

The palette and tokens above are unchanged. v3 adds four surface families:

**Billing & the threshold meter.** The meter is the most emotionally loaded component in the
product — it tells a merchant what they're about to pay. Use a horizontal progress bar with the
threshold as a labeled marker, filled in `chart-1`, switching to `warning-text` in the
"approaching" band and `brand-primary` once past. Always render three numbers together: trailing
12-month sales, threshold, and fee accrued. Projections use a dashed/hatched fill and the word
"projected" — never a solid fill implying settled fact. Processor fees appear in a visually
separate row labeled as the provider's, never blended into a Markii total. Before any sale exists,
the meter shows *not yet measured*, not an empty bar at zero. Follow the existing chart tokens for
any accompanying trend or breakdown visuals.

**Commerce surfaces.** Variant matrices use a compact table with sticky option headers and
inline stock counts; out-of-stock reads as text plus `disabled` styling, never color alone.
Order status pairs payment and fulfillment as two distinct badges — merging them hides state.
Exception states (`authorization_failed`, `inventory_changed`) use `error-bg`/`warning-bg` with an
explicit next action. Discount and price fields always show currency; refunds render as negative
amounts in `error-text` with the original alongside.

**The site builder** breaks the dashboard's normal chrome — it's a full-bleed workspace, not a
page in the shell. Canvas sits on `#F3F4F6` so white sections read as the page. Selection outline
is `brand-primary` at 2px; hover outline is 1px at 40% opacity; drop indicators are a 2px
`brand-primary` line with generous hit targets. The layer tree, inspector, and block library use
the standard panel styling. Every drag affordance has a visible focus state and a keyboard path.
Breakpoint switcher, publish state (draft / unpublished changes / published), and version history
live in the top bar; "unpublished changes" is the one persistent state merchants must never lose
track of.

**The ops agent chat panel** is a right-side dock, `surface` on `border`. Proposals render as
inline diff cards — old value struck through in `muted`, new value in `foreground`, affected count
as a badge — with Approve / Reject / Edit as real buttons, never a bare "OK". Executed actions show
a receipt with an Undo affordance and audit link. Streaming uses a subtle `brand-primary` caret;
no typing-dot theater. Errors from tool calls render verbatim in a mono block. Never style an
agent proposal as if it were already applied.

## Do's and Don'ts

**Do**

- Keep 90% of the UI in neutrals.
- Format money from integer cents; show clear empty and error states when `/api` is down.
- Use brand rose for primary CTA, active nav, charts, and status that warrants it.

**Don't**

- Recolor the whole chrome with the logo gradient.
- Dark-theme the product (binding plan is light).
- Invent an AI chat UI without an API contract.
- Put secrets (Stripe keys, service-account JSON, channel credentials) in URLs, logs, or
  localStorage — and never echo them back in a GET response.
- Build storefront `_sites` pages or mock `/api` handlers in the frontend track.
- Let x402 or crypto imagery dominate — rails are peers, shown as labeled configuration.
- Show a number, success state, or chart for something the backend never measured.
- Present a projected fee as an amount owed, or blend processor fees into a Markii total.
- Ship a builder interaction that only works with a mouse.
- Render an agent proposal as though it were already applied.
