# Markii Frontend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the Markii merchant dashboard + light landing against real `/api/*`, with resilient empty/error states until the backend lands.

**Architecture:** Next.js App Router FE-only. `lib/api` typed client → `docs/API.md`. Dashboard under `app/(dashboard)/dashboard/*`. Light tokens from `DESIGN.md`. No mocks, no `lib/db`, no `_sites`.

**Tech Stack:** Next 16, React 19, Tailwind 4, Motion, Lucide, Zod, existing Geist fonts.

---

### Task 1: Design tokens (light world)

**Files:**
- Modify: `app/globals.css`
- Modify: `components/logo.tsx` (gradient stops → visual plan)
- Modify: `app/icon.svg` if face fill must work on light chrome

**Step 1:** Replace `:root` CSS vars with light neutrals + brand rose from `DESIGN.md`.
**Step 2:** Map `@theme inline` colors; keep `.text-gradient` / `.bg-gradient-brand` for logo/CTA only.
**Step 3:** Update logo gradient stops to `#590D22` → `#FF758F` family; face fill to `#FAFAFA` or `#FFFFFF` as needed for light UI.
**Step 4:** `pnpm build` still succeeds (landing may look transitional until Task 4).

---

### Task 2: `lib/api` client foundation

**Files:**
- Create: `lib/api/types.ts` — Site, Product, Category, Order, TrafficEvent, paginated, ApiError
- Create: `lib/api/client.ts` — `apiGet/Post/Patch/Delete`, query string builder, throw typed errors
- Create: `lib/api/money.ts` — `formatCents(cents, currency?)`
- Create: `lib/api/overview.ts`, `sites.ts`, `products.ts`, `categories.ts` (stubs calling paths)
- Create: `lib/utils.ts` — `cn()` if missing (clsx + twMerge)

**Step 1:** Implement error parsing for `{ error: { code, message, details? } }`.
**Step 2:** Implement pagination query helpers (`page`, `limit`, `q`, filters).
**Step 3:** No `app/api` routes. Grep: dashboard must not import drizzle.

---

### Task 3: Dashboard shell

**Files:**
- Create: `app/(dashboard)/layout.tsx`
- Create: `app/(dashboard)/dashboard/page.tsx` (placeholder overview OK)
- Create: `components/dashboard/sidebar.tsx`
- Create: `components/dashboard/topbar.tsx`
- Create: `components/ui/button.tsx` (minimal primary/secondary/ghost)

**Step 1:** Sidebar nav links for all PLAN routes (pages may 404 until later tasks — create stub `page.tsx` exporting simple PageHeader + EmptyState for each).
**Step 2:** Active nav = rose left border.
**Step 3:** Background `#FAFAFA`; sidebar white.
**Step 4:** Verify `/dashboard` renders shell.

---

### Task 4: Landing restyle

**Files:**
- Modify: `app/page.tsx`

**Step 1:** Restyle to light Persuade hero: logo, one headline, one sentence, primary + secondary CTA, sparse color.
**Step 2:** Keep 2–3 intentional motions; respect `prefers-reduced-motion`.
**Step 3:** Remove dark ambient blobs / glass excess; optional restrained terminal proof using neutrals + brand accents on status lines only.
**Step 4:** Visual check: brand test — first viewport still reads as Markii without nav.

---

### Task 5: Shared UI states

**Files:**
- Create: `components/ui/page-header.tsx`, `empty-state.tsx`, `error-state.tsx`, `badge.tsx`, `money-text.tsx`, `status-dot.tsx`

**Step 1:** Wire EmptyState / ErrorState APIs used by overview.
**Step 2:** MoneyText uses `formatCents`.

---

### Task 6: Overview page (API-honest)

**Files:**
- Modify: `app/(dashboard)/dashboard/page.tsx`
- Create: `lib/api/overview.ts` (if not done)

**Step 1:** `GET /api/overview` in server component (or client with loading).
**Step 2:** Handle throw/network → ErrorState + retry; zeros → EmptyState + CTA to `/dashboard/websites/new`.
**Step 3:** Render site counts, traffic summary, balances via MoneyText.
**Step 4:** Manual smoke: API down vs empty vs success.

---

### Task 7: Stub remaining routes

**Files:** Create stub pages under:
- `inventory`, `categories`, `categories/[slug]`, `products/[slug]`
- `websites`, `websites/new`, `websites/[slug]`
- `analytics`, `analytics/[slug]`, `finances`, `finances/[slug]`, `integrations`

Each: PageHeader + EmptyState “Waiting on API” or minimal list shell. Prevents nav 404s.

---

### Task 8: Phase 1 screens (after shell ships)

Implement against API.md in order: websites list/detail → inventory/categories/products CRUD forms → uploads. Separate commits per screen group when user asks to commit.

---

### Task 9: Phase 2–4

Import + wizard (sandboxed iframe) → finances/analytics → integrations (secret field mitigations).

**Security acceptance (from red-team; enforce when those UIs land):**
- Preview: `srcdoc` + `sandbox` without `allow-same-origin`; never combine `allow-scripts` + `allow-same-origin`. `llms.txt` / `agent.md` as `<pre>` text only.
- Integrations: password/uncontrolled secret inputs; clear after PUT; no localStorage/draft persistence of `secretKey` / `serviceAccountJson`; no logging of PUT bodies. Demo copy: unauthenticated admin — don’t paste production secrets.
- Scrape URL: `https:` only; block localhost / link-local / metadata hosts / userinfo in URL (soft gate; BE owns real SSRF).
- Uploads: png/jpeg/webp ≤5MB; no SVG/HTML; CSV type/size client checks.

---

### Task 10: Verification gates

- `pnpm lint` && `pnpm build`
- Grep R1–R4: no drizzle in dashboard; no mock api; no secret console logs
- Security review via ai-security-reviewer before claiming Phase 1+ complete

---

## Notes

- Do not commit unless the user asks.
- Prefer small diffs; match existing project patterns.
- Auth absence is accepted risk — do not invent login.
