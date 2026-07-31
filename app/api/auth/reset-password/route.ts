import { NextResponse } from "next/server";
import { appUrl, handler } from "@/lib/api";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { emailOnlySchema } from "@/lib/validation";

/**
 * `POST /api/auth/reset-password` — sends the reset mail.
 *
 * **Always 200, even for an unknown address** (§16). Any difference in status,
 * body, or timing between "sent" and "no such account" turns this into an
 * account-enumeration oracle, which matters more here than anywhere else because
 * it needs no credentials to probe.
 */
export const POST = handler(async (req) => {
  const { email } = emailOnlySchema.parse(await req.json());

  const supabase = await getSupabaseServerClient();
  if (supabase) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl()}/api/auth/callback?next=/reset-password`,
    });
    // Logged, never returned. The caller learns nothing either way.
    if (error) console.error("password reset request failed", error.message);
  }

  return NextResponse.json({ ok: true });
});
