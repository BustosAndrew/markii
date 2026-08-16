import "server-only";

import type { User } from "@supabase/supabase-js";

/**
 * `user_kind` — the explicit staff/shopper marker D32 makes binding.
 *
 * Staff and storefront shoppers now share one Supabase project, so they no
 * longer get separate token audiences for free. This is the replacement: a
 * stated property on the user, checked on every staff path, rather than
 * "whichever table happens to have a row".
 *
 * ## It must live in `app_metadata`, never `user_metadata`
 *
 * This is the detail that decides whether the whole scheme works.
 * `user_metadata` is **writable by the user** — any signed-in shopper can call
 * `updateUser({ data: … })` and set whatever they like. Storing `user_kind`
 * there would let a customer promote themselves to staff with one API call.
 *
 * `app_metadata` is writable only with the service-role key, which never leaves
 * the server. That is what makes this a boundary rather than a suggestion.
 */

export type UserKind = "staff" | "customer";

const CLAIM = "user_kind";

/**
 * Reads the marker. **Absent means staff**, deliberately.
 *
 * Shopper sign-up is the only path that creates a customer identity and it
 * always stamps `"customer"`, so an unmarked user cannot be a shopper. Treating
 * absence as "customer" instead would lock out every account created before this
 * existed, which is a worse failure with no security gain — the membership
 * lookup is still the gate either way.
 */
export function userKindOf(user: Pick<User, "app_metadata">): UserKind {
  const raw = (user.app_metadata as Record<string, unknown> | null)?.[CLAIM];
  return raw === "customer" ? "customer" : "staff";
}

export function isStaffUser(user: Pick<User, "app_metadata">): boolean {
  return userKindOf(user) === "staff";
}

/** The `app_metadata` patch to stamp on a user at creation. Service-role only. */
export function userKindMetadata(kind: UserKind): { user_kind: UserKind } {
  return { [CLAIM]: kind } as { user_kind: UserKind };
}

const SITE_CLAIM = "site_id";

/**
 * Which storefront a shopper belongs to (§24, Send Email Hook).
 *
 * **Auth mail is the reason this exists.** Supabase's Send Email Hook hands over
 * a user and a token and expects the application to send the message — and a
 * shopper's message has to come from *their merchant's* verified domain, so the
 * hook must be able to answer "whose customer is this?" from the user alone.
 *
 * Nothing else could answer it reliably. `redirect_to` is a URL that varies by
 * flow and is partly caller-supplied; `customers` is keyed by `siteId`, so one
 * email address can legitimately exist on several stores and a lookup by
 * address is ambiguous by construction.
 *
 * In `app_metadata` for exactly the reason `user_kind` is: `user_metadata` is
 * user-writable, and a shopper who could edit this could make their store's auth
 * mail send from another merchant's domain.
 *
 * Staff have no site — they belong to an organization, and their mail is
 * Markii's own.
 */
export function shopperSiteMetadata(siteId: number): { site_id: number } {
  return { [SITE_CLAIM]: siteId } as { site_id: number };
}

/** The storefront a shopper belongs to, or null for staff and older accounts. */
export function shopperSiteIdOf(user: Pick<User, "app_metadata">): number | null {
  const raw = (user.app_metadata as Record<string, unknown> | null)?.[SITE_CLAIM];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}
