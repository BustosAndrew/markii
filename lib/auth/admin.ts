import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { userKindMetadata, type UserKind } from "./user-kind";

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
): Promise<{ ok: boolean; reason?: string }> {
  const admin = adminClient();
  if (!admin) {
    return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY is not configured" };
  }
  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: userKindMetadata(kind),
  });
  if (error) {
    console.error("[auth] failed to stamp user_kind", error.message);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}
