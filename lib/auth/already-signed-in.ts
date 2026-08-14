import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * True when the caller already holds a session, so `/sign-in` and `/sign-up`
 * can bounce them to the dashboard instead of showing a login form.
 *
 * Landing on a sign-in page with a live session is what made "go home from the
 * dashboard" feel like being signed out: the marketing CTA pointed at
 * `/sign-up`, and signing in again was the only obvious way back.
 *
 * There is no redirect loop hiding here. `/dashboard` sends people back to
 * `/sign-in` only when `proxy.ts` or the dashboard layout finds **no user**,
 * and both ask the same `getUser()` this does — so the two conditions cannot
 * both be true.
 *
 * A session at `aal1` still counts. It is a real session; the dashboard layout
 * routes it to `/mfa`, which is where that merchant should be (D40). Returning
 * false here would instead park them on a sign-in form that cannot help.
 */
export async function requireNoSession(): Promise<boolean> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return false;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user);
}
