import { NextResponse } from "next/server";
import { ApiError, badRequest, handler, unauthorized } from "@/lib/api";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { updatePasswordSchema } from "@/lib/validation";

/**
 * `POST /api/auth/update-password` — authorized by the recovery session that
 * `/api/auth/callback` established, or by an ordinary signed-in session (§16).
 */
export const POST = handler(async (req) => {
  const { password } = updatePasswordSchema.parse(await req.json());

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new ApiError("INTERNAL", 503, "Authentication is not configured");
  }

  // Revalidates against Supabase rather than trusting the cookie's claims —
  // this endpoint changes a credential, so it is the last place to take a
  // cookie at its word.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw unauthorized("Password reset link is invalid or has expired");

  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw badRequest(error.message);

  return NextResponse.json({ ok: true });
});
