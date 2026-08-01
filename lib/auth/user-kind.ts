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
