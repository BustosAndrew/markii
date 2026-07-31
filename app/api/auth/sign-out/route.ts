import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { ACTIVE_ORG_COOKIE } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/** `POST /api/auth/sign-out` — clears the session cookie (§16). */
export const POST = handler(async () => {
  const supabase = await getSupabaseServerClient();

  // Revokes the refresh token server-side; the adapter clears the cookies as a
  // side effect. Signing out must succeed even if that call fails, otherwise a
  // Supabase outage leaves people unable to end a session on a shared machine.
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("sign-out revoke failed", e);
    }
  }

  const store = await cookies();
  store.delete(ACTIVE_ORG_COOKIE);

  return NextResponse.json({ ok: true });
});
