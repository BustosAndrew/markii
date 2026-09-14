import { NextResponse } from "next/server";
import { ApiError, handler, unauthorized } from "@/lib/api";
import { ensureFirstOrg } from "@/lib/auth/provisioning";
import { enforceAuthLimit, readJsonBody } from "@/lib/auth/rate-limits";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { credentialsSchema } from "@/lib/validation";

/**
 * `POST /api/auth/sign-in` — sets the session cookie (§16, D30).
 *
 * The cookie is written by the `setAll` adapter in `lib/supabase/server.ts`,
 * which stamps `httpOnly` / `secure` / `sameSite: lax` on everything it sets.
 *
 * **Rate limited per address and per email** (G12). Supabase's own sign-in
 * limit sees only Vercel's address, so without this a password-spraying run
 * would spend the whole platform's allowance and lock every merchant out.
 */
export const POST = handler(async (req) => {
  const body = await readJsonBody(req);
  await enforceAuthLimit("signIn", req, body.email);
  const { email, password } = credentialsSchema.parse(body);

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
