import { NextResponse } from "next/server";
import { ApiError, appUrl, badRequest, handler } from "@/lib/api";
import { ensureFirstOrg } from "@/lib/auth/provisioning";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { credentialsSchema } from "@/lib/validation";

/**
 * `POST /api/auth/sign-up` — creates the user *and* their first org (§16).
 *
 * Runs server-side (D30): the browser posts credentials to Markii's own origin
 * and the server sets the httpOnly cookie. No `createBrowserClient` exists.
 */
export const POST = handler(async (req) => {
  const { email, password } = credentialsSchema.parse(await req.json());

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new ApiError("INTERNAL", 503, "Authentication is not configured");
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${appUrl()}/api/auth/callback?next=/dashboard` },
  });

  if (error) {
    // Supabase returns 422 for weak passwords and similar; surface it as a
    // validation error rather than a 500 so the form can render it inline.
    throw badRequest(error.message);
  }
  if (!data.user) throw badRequest("Sign-up did not return a user");

  // Idempotent: Supabase intentionally returns a plausible user for an existing
  // address so sign-up cannot enumerate accounts, so this must not mint a
  // second org on a repeat submission.
  await ensureFirstOrg(data.user.id, email);

  // No session means email confirmation is on and the user must click through.
  // Say so plainly rather than implying they are signed in.
  return NextResponse.json(
    { ok: true, emailConfirmationRequired: data.session === null },
    { status: 201 },
  );
});
