import { invokeAction } from "./actions";
import { apiGet } from "./client";
import { callWhenLive } from "./planned";

const SECTION = "API §23 (storefront secret keys)";

/**
 * ✅ LIVE — `GET /api/sites/:idOrSlug/storefront-keys` and the two
 * `storefront.*` actions (D53, 2026-11-20). **Needs migration 0050.**
 *
 * A storefront secret key is what an **exported** storefront's server sends so
 * its signed-in shoppers can buy and use members-only products: the export's
 * own sign-in says who the shopper is, and the key is how Markii believes it.
 * Whoever holds one can act as any customer of that store, so treat it like a
 * password: it belongs in the export's server environment, never in browser
 * code — Markii refuses a key that arrives with an `Origin` header.
 */
const STOREFRONT_KEYS_API_LIVE = true;

export type StorefrontKey = {
  id: number;
  label: string;
  /** Identifies a key in a list. Not the key, and not enough to use it. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export function listStorefrontKeys(site: number | string, init?: RequestInit) {
  return callWhenLive(STOREFRONT_KEYS_API_LIVE, SECTION, () =>
    apiGet<{ siteId: number; keys: StorefrontKey[] }>(`/api/sites/${site}/storefront-keys`, undefined, init),
  );
}

/**
 * Create a key. **`key` is the only copy that will ever exist** — show it once
 * with a copy button and say so; the audit log stores a placeholder in its
 * place. `high` and step-up: expect `403 MFA_REQUIRED` and let
 * `MfaStepUpProvider` handle it.
 */
export function createStorefrontKey(body: { siteId: number; label: string }, init?: RequestInit) {
  return invokeAction<{ siteId: number; label: string; id: number; prefix: string; key: string }>(
    "storefront.createKey",
    body,
    init,
  );
}

/** Revoke a key. Immediate; requests carrying it answer `401` from then on. Not undoable — create a new key instead. */
export function revokeStorefrontKey(body: { siteId: number; keyId: number }, init?: RequestInit) {
  return invokeAction<{ keyId: number; prefix: string; revokedAt: string; alreadyRevoked: boolean }>(
    "storefront.revokeKey",
    body,
    init,
  );
}
