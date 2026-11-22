import { dryRunAction, invokeAction } from "./actions";

/**
 * ✅ LIVE — the `store.export` action (D53, 2026-11-21), through
 * `POST /api/actions/store.export`. No migration.
 *
 * Exports one store **whole** — catalogue, inventory, collections, customers
 * (with addresses and memberships), orders (with refunds and fulfillments),
 * discounts, shipping and tax settings, sold files and the design — as a zip a
 * self-hosted Markii imports with `pnpm store:import`.
 *
 * **It contains every customer's personal data.** Owner and administrator
 * only (`store.export`; `canExportStore` in `./org`), `high` and step-up:
 * expect `403 MFA_REQUIRED` and let `MfaStepUpProvider` handle it. Agents and
 * API tokens are refused.
 *
 * Two clocks, both worth saying beside the button:
 * - `url` is a **five-minute** link to the zip. Open it; never store it.
 * - The links *inside* the zip to the store's sold files expire at
 *   `files.linksExpireAt` (24 hours) — import before then, or export again.
 *
 * `headCodeLeftOut: true` means the store has custom scripts, which never
 * travel; say so. `previewStoreExport` returns `counts` without making a file —
 * worth showing as "this will include 1,204 customers and 3,880 orders"
 * before the person confirms.
 */
export type StoreExport = {
  url: string;
  expiresAt: string;
  bytes: number;
  /** Rows per table, keyed by table — `customers`, `orders`, `products`, … */
  counts: Record<string, number>;
  files: { digitalAssets: number; publicMedia: number; linksExpireAt: string };
  headCodeLeftOut: boolean;
};

export function exportStore(siteId: number, init?: RequestInit) {
  return invokeAction<StoreExport>("store.export", { siteId }, init);
}

/** What an export would hold — `counts` and `files` — without making one. Needs no second factor. */
export function previewStoreExport(siteId: number, init?: RequestInit) {
  return dryRunAction<StoreExport>("store.export", { siteId }, init);
}
