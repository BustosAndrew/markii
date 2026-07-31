import { NextResponse } from "next/server";
import { ApiError, handler, unauthorized } from "@/lib/api";
import { ensureFirstOrg } from "@/lib/auth/provisioning";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { credentialsSchema } from "@/lib/validation";

/**
 * `POST /api/auth/sign-in` — sets the session cookie (§16, D30).
 *
 * The cookie is written by the `setAll` adapter in `lib/supabase/server.ts`,
 * which stamps `httpOnly` / `secure` / `sameSite: lax` on everything it sets.
 */
export const POST = handler(async (req) => {
  const { email, password } = credentialsSchema.parse(await req.json());

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new ApiError("INTERNAL", 503, "Authentication is not configured");
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    // One message for wrong password and unknown account alike — distinguishing
    // them turns the sign-in form into an account-enumeration oracle.
    throw unauthorized("Invalid email or password");
  }

  // Covers the account that confirmed by email before any org existed, and any
  // future path that creates a user outside sign-up. Cheap, and the alternative
  // is a signed-in user with nowhere to go.
  await ensureFirstOrg(data.user.id, data.user.email ?? email);

  return NextResponse.json({ ok: true });
});
