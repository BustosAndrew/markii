import { dryRunAction, invokeAction } from "./actions";
import { apiGet } from "./client";
import { callWhenLive } from "./planned";

const SECTION = "API §19 (storefront redirects)";

/**
 * ✅ LIVE — `GET /api/sites/:idOrSlug/redirects` and the four `redirects.*`
 * actions (2026-11-21). **Needs migration 0051.**
 *
 * A redirect sends an old link — usually from the platform a merchant moved
 * from — to where that thing lives now. It fires **only when nothing else
 * answers the old path**, so it can never hide a live page or product, and it
 * is live the moment it is saved (not part of the draft design or publish).
 *
 * Validation refusals are `400 VALIDATION_ERROR` with `details.field` (`from`
 * or `to`) and a sentence to show as is. `409` carries `details.reason`:
 * `from_taken`, `loop` or `limit` (10,000 per store).
 */
const REDIRECTS_API_LIVE = true;

export type Redirect = {
  id: number;
  /** Stored normalised: leading slash, no query, no trailing slash, lower case. */
  from: string;
  /** A path on this store or an absolute https URL, as saved. */
  to: string;
  /** 308 when true, 307 when false. */
  permanent: boolean;
  createdBy: string;
  createdAt: string;
};

export function listRedirects(
  site: number | string,
  query: { q?: string; limit?: number; offset?: number } = {},
  init?: RequestInit,
) {
  return callWhenLive(REDIRECTS_API_LIVE, SECTION, () =>
    apiGet<{ siteId: number; total: number; items: Redirect[] }>(`/api/sites/${site}/redirects`, query, init),
  );
}

type RedirectResult = { redirectId: number; from: string; to: string; permanent: boolean };

/** `from` may be pasted as a full URL from the old store — its host is dropped. Undoable. */
export function createRedirect(body: { siteId: number; from: string; to: string; permanent?: boolean }, init?: RequestInit) {
  return invokeAction<RedirectResult>("redirects.create", body, init);
}

/** Change the target or permanence; the old link stays. Undoable. */
export function updateRedirect(body: { siteId: number; redirectId: number; to?: string; permanent?: boolean }, init?: RequestInit) {
  return invokeAction<RedirectResult>("redirects.update", body, init);
}

/** Undoable — undo recreates the rule under a new id. */
export function deleteRedirect(body: { siteId: number; redirectId: number }, init?: RequestInit) {
  return invokeAction<{ redirectId: number }>("redirects.delete", body, init);
}

export type RedirectImportBody = {
  siteId: number;
  /** At most 1,000 per call. */
  redirects: { from: string; to: string; permanent?: boolean }[];
  /** Replace an existing redirect from the same old link instead of skipping the row. */
  replace?: boolean;
};

export type RedirectImportResult = {
  created: number;
  replaced: number;
  /** `row` is the index in the list sent; `reason` is a sentence to show beside it. */
  skipped: { row: number; from: string; reason: string }[];
  total: number;
};

/** Show this report before saving: same body, nothing written. */
export function previewRedirectImport(body: RedirectImportBody, init?: RequestInit) {
  return dryRunAction<RedirectImportResult>("redirects.import", body, init);
}

/** Bad rows are skipped and reported; the rest land together. Not undoable. */
export function importRedirects(body: RedirectImportBody, init?: RequestInit) {
  return invokeAction<RedirectImportResult>("redirects.import", body, init);
}
