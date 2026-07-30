# Markii Frontend Design

> ⚠️ **SUPERSEDED — historical record only. Do not build from this.**
> Written for the v1 dashboard against the Neon-era stack. Current frontend guidance is
> **`docs/FRONTEND.md`**; current contracts are `docs/API.md`; current decisions are
> `docs/DECISIONS.md`. Kept for context on why the v1 dashboard looks the way it does.

**Date:** 2026-07-24  
**Status:** Superseded (was: Approved)  
**Approach:** Shell-first, API-honest (Approach 1)

## Problem

Merchants need an admin UI to import catalogs, deploy agent-readable storefronts, and monitor agent traffic and payouts. Backend (API, DB, `_sites`, x402) is teammate-owned. Frontend must ship a light, restrained Operate dashboard + Persuade landing that calls real `/api/*` only.

## Decisions (approved)

1. **Users:** Merchants / store operators (admin dashboard).
2. **Data:** Real `/api/*` only — loading / empty / error until backend is up. No client mocks, no temporary `app/api` stubs.
3. **Visual world:** Light `#FAFAFA` neutrals; brand rose reserved for logo, primary CTA, active nav, AI/status, charts (`DESIGN.md`, visual-design-plan).
4. **Architecture:** `app/(dashboard)/dashboard/*` URLs; FE-only `lib/api/*`; no Drizzle / `_sites` / middleware.
5. **Phasing:** Foundation → CRUD → import/wizard → finances/analytics → integrations.

## Architecture

- Landing `/` — Persuade, light restyle of existing page.
- Dashboard route group with sidebar + top bar Operate chrome.
- Typed fetch client matching `docs/API.md` (pagination, error envelope, integer cents).
- Server Components for first paint; client for interactive flows.

## IA

Sidebar: Overview, Inventory, Categories, Websites, Analytics, Finances, Integrations — routes per `docs/PLAN.md` / PDF brief.

## Components & states

Shared: Button, Input, Badge, DataTable, PageHeader, ConfirmDialog, MoneyText, EmptyState, ErrorState, StatusDot. Domain: SiteCard, ImportDialog, PreviewPanes (sandboxed iframe), AgentPopup, ProviderCard. Every data view: loading → empty → error → success.

## Evaluation gates

- Shell light theme; nav matches PLAN.
- API honesty: distinct loading/empty/error; no fake metrics.
- Money: shared cents formatter; lists honor `{ items, total, page, limit }`.
- Safety: no drizzle in dashboard tree; no secret logging; sandboxed preview when wizard exists.
- `pnpm lint` + `pnpm build` clean.

## Safety (accepted + FE mitigations)

- **Accepted:** Auth none — open admin (hackathon). Documented in PRODUCT.md / API.md.
- **FE:** Mask integration secrets; no localStorage of keys; client upload type/size checks; scrape URL basic validation; sandboxed `srcdoc` preview.

## Rollout / rollback

- Ship by phase; each phase independently usable with empty/error states.
- Rollback = revert FE commits; no mock layer to unwind.
- Feature completeness gated on teammate API availability, not FE inventing data.

## References

- `PRODUCT.md`, `DESIGN.md`
- `docs/PLAN.md`, `docs/API.md`
- `/Users/Lonestar/Downloads/visual-design-plan.md`, `markii.pdf`
