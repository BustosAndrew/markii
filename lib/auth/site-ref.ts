import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A signed "which storefront is this shopper signing up to" token (§24).
 *
 * ## Why this exists
 *
 * Supabase fires the Send Email Hook *during* `auth.signUp()` — before the
 * route can stamp `app_metadata`. So at the moment the confirmation email is
 * generated, the brand-new user has no `user_kind` and no `site_id`, and the
 * hook routes them to the staff stream: the shopper's very first email goes out
 * branded Markii from `markii.shop` instead of from their merchant. Confirmed
 * live, not theorised.
 *
 * ## Why not the obvious fixes
 *
 * **Create the user with the admin API first.** `admin.createUser` returns a
 * clear error for an address that already exists, while `auth.signUp`
 * deliberately does not — it returns a success-shaped response so a public
 * sign-up form cannot be used to enumerate who has an account. Reordering that
 * way would trade a branding bug for an enumeration hole on a storefront.
 *
 * **Put the site id in `user_metadata`.** It survives the ordering problem, and
 * it is *writable by the user* — anyone could call Supabase's public sign-up API
 * with another merchant's site id and receive a genuine, DKIM-signed email from
 * that merchant's domain.
 *
 * ## What this does instead
 *
 * The site id travels in `user_metadata` where the ordering works, but carries
 * an HMAC only the server can produce. The value is readable and self-describing
 * — it is not a secret — but it cannot be *forged*, which is the property that
 * matters. `app_metadata` remains authoritative for every later email; this only
 * has to survive the first one.
 *
 * Keyed on the service-role key: already server-only, already required for
 * sign-up to work at all, and deliberately not a new secret to configure on a
 * deployment that is already live.
 */

function key(): Buffer | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return secret ? Buffer.from(secret) : null;
}

function mac(siteId: number, k: Buffer): string {
  return createHmac("sha256", k).update(`shopper-site:${siteId}`).digest("base64url");
}

/** `<siteId>.<mac>` — produced server-side at sign-up, never by a client. */
export function signSiteRef(siteId: number): string | null {
  const k = key();
  if (!k) return null;
  return `${siteId}.${mac(siteId, k)}`;
}

/**
 * The site id a ref attests to, or null.
 *
 * Returns null rather than throwing on every malformed shape: this reads
 * attacker-influenced input, and the caller's job is to fall through to a
 * refusal, not to handle exceptions.
 */
export function verifySiteRef(ref: unknown): number | null {
  if (typeof ref !== "string") return null;
  const k = key();
  if (!k) return null;

  const dot = ref.indexOf(".");
  if (dot <= 0) return null;

  const siteId = Number(ref.slice(0, dot));
  if (!Number.isInteger(siteId) || siteId <= 0) return null;

  const provided = Buffer.from(ref.slice(dot + 1));
  const expected = Buffer.from(mac(siteId, k));
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? siteId : null;
}
