import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Storefront secret keys (D53) — the pure half: minting, hashing and reading
 * the two headers. The lookup is `lib/auth/storefront-keys.ts`.
 *
 * **What a key is for.** An exported storefront's shopper sign-in is its
 * owner's (owner, 2026-11-20), so Markii never hands a shopper a credential
 * that works off its own hosts. The export's **server** holds this key and
 * names the shopper it is acting for; Markii maps that to the store's own
 * `customers` row. That one step is what lets a member buy and use
 * members-only products from an export.
 */

/** `mksk_live_` — distinct from staff tokens' `mk_live_`, so a secret scanner and a reader can tell them apart. */
export const STOREFRONT_KEY_PREFIX = "mksk_live_";
const KEY_BYTES = 32;

/** The shopper the export's server is acting for — an address **the owner's own sign-in has verified**. */
export const SHOPPER_EMAIL_HEADER = "markii-shopper-email";

export type MintedStorefrontKey = { plaintext: string; hash: string; prefix: string };

export function mintStorefrontKey(): MintedStorefrontKey {
  const secret = randomBytes(KEY_BYTES).toString("base64url");
  const plaintext = `${STOREFRONT_KEY_PREFIX}${secret}`;
  return { plaintext, hash: hashStorefrontKey(plaintext), prefix: `${STOREFRONT_KEY_PREFIX}${secret.slice(0, 6)}` };
}

/** Plain SHA-256, for the reason `lib/auth/tokens.ts` gives: 256 random bits need no slow KDF. */
export function hashStorefrontKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * The key from `Authorization: Bearer mksk_live_…`, or null. A bearer value of
 * any other shape is not ours to judge here — a staff token sent to a
 * storefront is ignored exactly as it was before keys existed.
 */
export function storefrontKeyFrom(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const value = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  return value && value.startsWith(STOREFRONT_KEY_PREFIX) ? value : null;
}

const email = z.email().max(255);

/**
 * The asserted shopper: `{ email: null }` when the header is absent (the export's
 * server acting as a guest), `{ invalid: true }` when it is present and not an
 * address. Lowercased, like every `customers.email`.
 */
export function shopperEmailFrom(headers: Headers): { email: string | null } | { invalid: true } {
  const raw = headers.get(SHOPPER_EMAIL_HEADER);
  if (raw === null || raw.trim() === "") return { email: null };
  const parsed = email.safeParse(raw.trim().toLowerCase());
  return parsed.success ? { email: parsed.data } : { invalid: true };
}
