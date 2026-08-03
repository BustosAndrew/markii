import "server-only";

import { and, eq } from "drizzle-orm";
import type { User } from "@supabase/supabase-js";
import { customers, db } from "../db";
import { getSupabaseServerClient } from "../supabase/server";
import { userKindOf } from "./user-kind";

/**
 * Storefront shopper identity (§18.3) — the other identity domain from
 * `lib/auth/session.ts`, and deliberately not sharing a helper with it.
 *
 * **Three things keep the domains apart, and all three are load-bearing (D32):**
 *
 * 1. **`user_kind` is checked on every path.** Staff and shoppers live in one
 *    Supabase project, so a staff session is a structurally valid session here
 *    and vice versa. `getShopperUser()` refuses staff exactly as `getAuthUser()`
 *    refuses shoppers.
 * 2. **Session cookies are host-only.** `SESSION_COOKIE_OPTIONS` sets no
 *    `domain`, so a cookie written on `{slug}.markii.shop` is never sent to the
 *    dashboard — which matters because merchant custom code runs on storefronts.
 * 3. **Authorization resolves through the `customers` row, never
 *    `auth.getUser()` alone.** Being signed in is not being a customer *of this
 *    store*; `currentCustomer()` is the gate, and it is scoped by `siteId`.
 */

export function isShopperUser(user: Pick<User, "app_metadata">): boolean {
  return userKindOf(user) === "customer";
}

/**
 * Read credentials from either a JSON body or an HTML form post.
 *
 * The storefront account page uses a plain `<form>` with no JavaScript, because
 * `CLAUDE.md` sanctions only three storefront islands and an account page is not
 * one of them. Accepting both shapes is what lets the same route serve that form
 * and a programmatic caller without a client component existing at all.
 */
export async function readCredentialBody(
  req: Request,
): Promise<{ values: Record<string, string>; isFormPost: boolean }> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("form")) {
    const form = await req.formData();
    const values: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") values[k] = v;
    }
    return { values, isFormPost: true };
  }

  const raw = await req.text();
  return { values: raw ? JSON.parse(raw) : {}, isFormPost: false };
}

/**
 * The signed-in shopper, or null.
 *
 * Returns null for a staff user rather than throwing: from a storefront's point
 * of view an admin browsing the shop is simply not a shopper, and a 500 would
 * make a store look broken to its own owner.
 */
export async function getShopperUser(): Promise<User | null> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;

  // `getUser()` revalidates against Supabase. `getSession()` would trust the
  // cookie's own claims, which is what an attacker would prefer we did.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  return isShopperUser(user) ? user : null;
}

/**
 * Link a shopper's auth identity to a customer record for one store, creating
 * the record if this is their first visit.
 *
 * **Only ever links a pre-existing guest record once the address is confirmed.**
 * Guest checkout writes `customers` rows keyed by email, and those rows carry
 * order history. Attaching one to whoever signs up with that address would let
 * anybody claim a stranger's orders by typing their email — so an unconfirmed
 * shopper gets a session but no linkage, and the link happens on their next
 * request after confirming.
 *
 * Note this makes the behaviour depend on the Supabase project's email
 * confirmation setting: with confirmations disabled, Supabase marks addresses
 * confirmed immediately and the protection above is only as strong as that
 * setting. That is stated rather than assumed away.
 */
export async function ensureCustomerForShopper(
  siteId: number,
  user: User,
): Promise<typeof customers.$inferSelect | null> {
  const [alreadyLinked] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.siteId, siteId), eq(customers.authUserId, user.id)))
    .limit(1);
  if (alreadyLinked) return alreadyLinked;

  const email = user.email?.toLowerCase();
  if (!email) return null;
  if (!user.email_confirmed_at) return null;

  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.siteId, siteId), eq(customers.email, email)))
    .limit(1);

  if (existing) {
    // Owned by a different identity: refuse to move it rather than reassigning
    // someone's order history. Returning null degrades to "signed in, no
    // records here", which is safe.
    if (existing.authUserId && existing.authUserId !== user.id) return null;

    const [linked] = await db
      .update(customers)
      .set({ authUserId: user.id, updatedAt: new Date() })
      .where(eq(customers.id, existing.id))
      .returning();
    return linked ?? null;
  }

  /**
   * Two requests from one shopper can race here; the unique index on
   * `(siteId, email)` is what decides it, and the conflict branch adopts the row
   * the other request wrote rather than failing the sign-in.
   */
  const [created] = await db
    .insert(customers)
    .values({ siteId, email, authUserId: user.id })
    .onConflictDoUpdate({
      target: [customers.siteId, customers.email],
      set: { authUserId: user.id, updatedAt: new Date() },
    })
    .returning();

  return created ?? null;
}

/**
 * The customer record for the shopper browsing this store, or null.
 *
 * **This is the authorization gate**, not `getShopperUser()`. A shopper with an
 * account at store A signing into store B is a real, ordinary case — they are
 * one auth user with two customer records, or one and none. Gating on the
 * session alone would hand store A's members access to store B's gated catalog.
 */
export async function currentCustomer(
  siteId: number,
): Promise<typeof customers.$inferSelect | null> {
  const user = await getShopperUser();
  if (!user) return null;
  return ensureCustomerForShopper(siteId, user);
}

/** Just the id, for the gating helpers that need nothing else. */
export async function currentCustomerId(siteId: number): Promise<number | null> {
  return (await currentCustomer(siteId))?.id ?? null;
}
