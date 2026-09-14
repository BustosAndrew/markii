import { NextResponse } from "next/server";
import { appUrl, handler } from "@/lib/api";
import { enforceAuthLimit, readJsonBody } from "@/lib/auth/rate-limits";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { emailOnlySchema } from "@/lib/validation";

/**
 * `POST /api/auth/reset-password` — sends the reset mail.
 *
 * **Always 200, even for an unknown address** (§16). Any difference in status,
 * body, or timing between "sent" and "no such account" turns this into an
 * account-enumeration oracle, which matters more here than anywhere else because
 * it needs no credentials to probe.
 *
 * **Rate limited per address and per email** (G12), and this is the one place
 * the limit is *not* an enumeration risk: it counts submitted addresses whether
 * or not they are registered, so a 429 says only that someone has been asking.
 * Each accepted request is a mail from `markii.shop`, which is the resource
 * being protected.
 */
export const POST = handler(async (req) => {
  const body = await readJsonBody(req);
  await enforceAuthLimit("passwordReset", req, body.email);
  const { email } = emailOnlySchema.parse(body);

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
