import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { shopperSiteMetadata, userKindMetadata, type UserKind } from "./user-kind";

/**
 * Service-role Supabase client — **server-only, never the browser** (D6).
 *
 * The service-role key bypasses RLS entirely. It exists here for the one thing
 * the anon key cannot do: write `app_metadata`, which is what makes `user_kind`
 * a boundary rather than a user-editable label (D32).
 */
function adminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function isAdminConfigured() {
  return adminClient() !== null;
}

/**
 * Stamps `user_kind` into `app_metadata`.
 *
 * Failure is returned, not thrown: sign-up has already created the account by
 * this point, so throwing would leave a user who exists but got a 500. The
 * caller decides — and `userKindOf` treats an unstamped user as staff, which is
 * the safe direction for a *staff* signup that failed to stamp.
 */
export async function setUserKind(
  userId: string,
  kind: UserKind,
  /**
   * The storefront a shopper belongs to. Written in the **same** admin call as
   * `user_kind` on purpose: two calls could leave a shopper stamped as a
   * customer with no site, and that user's auth mail would then have no
   * merchant to send from — a broken account created by a partial write.
   */
  siteId?: number,
): Promise<{ ok: boolean; reason?: string }> {
  const admin = adminClient();
  if (!admin) {
    return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY is not configured" };
  }
  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...userKindMetadata(kind),
      ...(kind === "customer" && siteId ? shopperSiteMetadata(siteId) : {}),
    },
  });
  if (error) {
    console.error("[auth] failed to stamp user_kind", error.message);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

/**
 * Removes every MFA factor on a user (G12 — `platform.resetMfa`).
 *
 * **Through the admin API, not the user's session.** The merchant's own
 * recovery path (`/api/auth/mfa/recover`) unenrolls with their session, which
 * is exactly what a locked-out merchant does not have. Unverified factors go
 * too: a half-finished enrolment left behind would be picked up by the next
 * `challenge` and confuse the fresh one.
 *
 * Reports what it removed and what failed rather than throwing on the first
 * error, so the caller can refuse to report success when a factor survived.
 */
export async function removeAllMfaFactors(
  userId: string,
): Promise<{ ok: true; removed: number } | { ok: false; removed: number; reason: string }> {
  const admin = adminClient();
  if (!admin) return { ok: false, removed: 0, reason: "SUPABASE_SERVICE_ROLE_KEY is not configured" };

  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) return { ok: false, removed: 0, reason: error.message };

  let removed = 0;
  const failures: string[] = [];
  for (const factor of data?.factors ?? []) {
    const { error: delError } = await admin.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
    if (delError) failures.push(delError.message);
    else removed += 1;
  }
  return failures.length
    ? { ok: false, removed, reason: failures.join("; ") }
    : { ok: true, removed };
}
