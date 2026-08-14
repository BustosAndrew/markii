import { AuthForm } from "@/components/auth/auth-form";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Reads cookies, so there was never anything to prerender. Declared rather than
 * left to be discovered: without it Next attempts a static pass, `cookies()`
 * throws a `DynamicServerError` mid-render, and the build logs a failure for a
 * page that was always going to be dynamic.
 */
export const dynamic = "force-dynamic";

/**
 * One URL, two steps.
 *
 * `/api/auth/reset-password` mails a link back to
 * `/api/auth/callback?next=/reset-password`, so whoever clicks it arrives
 * *here* already holding a recovery session. Until this branch existed they
 * were shown the "enter your email" form a second time — an unbreakable loop,
 * because the completion step had a route and a typed client but no screen.
 *
 * The session decides which step to render. It does **not** authorize the
 * change: `POST /api/auth/update-password` re-reads the user from Supabase and
 * refuses on its own, so a stale or forged cookie gets a form and then a 401,
 * never a password change.
 */
export default async function ResetPasswordPage() {
  const supabase = await getSupabaseServerClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;

  return user ? <SetPasswordForm /> : <AuthForm mode="reset-password" />;
}
