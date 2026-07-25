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

## Do's and Don'ts

**Do**

- Keep 90% of the UI in neutrals.
- Format money from integer cents; show clear empty and error states when `/api` is down.
- Use brand rose for primary CTA, active nav, charts, and status that warrants it.

**Don't**

- Recolor the whole chrome with the logo gradient.
- Dark-theme the product (binding plan is light).
- Invent an AI chat UI without an API contract.
- Put secrets (Stripe keys, service-account JSON) in URLs, logs, or localStorage.
- Build storefront `_sites` pages or mock `/api` handlers in the frontend track.
