import { NextResponse } from "next/server";
import { ApiError, badRequest, handler, unauthorized } from "@/lib/api";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { updateEmailSchema } from "@/lib/validation";

/**
 * `POST /api/auth/update-email` — start moving an account to a new address (§16).
 *
 * **This only *requests* the change; it never applies one.** Supabase writes
 * `new_email` and mails confirmation links, and the address on the account moves
 * when those are followed. Returning `ok` here means "we asked", which is why
 * the response says so rather than reporting a new address the caller does not
 * have yet.
 *
 * With Supabase's **Secure email change** enabled — it is — that produces *two*
 * messages: one to the address on the account and one to the address it would
 * move to, and both must be confirmed. `lib/email/auth-hook.ts` routes each to
 * its own recipient and its own copy; the mail to the current address is the one
 * that stops a takeover, so it names the destination and tells the reader to
 * secure the account rather than to ignore it.
 *
 * **Server-side, like every other auth mutation** (D30). The browser never holds
 * a Supabase client, so the session cookie stays `HttpOnly` — merchant custom
 * code runs on storefronts and XSS there must not reach an admin session.
 */
export const POST = handler(async (req) => {
  const { email } = updateEmailSchema.parse(await req.json());

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new ApiError("INTERNAL", 503, "Authentication is not configured");
  }

  /**
   * Revalidated against Supabase rather than read from the cookie's claims.
   * Changing the address on an account is a credential-shaped act — it decides
   * where every future reset link goes — so this is not a place to take a cookie
   * at its word.
   */
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw unauthorized("Sign in to change your email address");

  /**
   * Refused rather than passed through. Supabase treats a no-op change as
   * success and sends mail for it, which would tell someone their address was
   * being moved when nothing was happening — an alarming message about a change
   * that does not exist.
   */
  if (user.email && user.email.toLowerCase() === email.toLowerCase()) {
    throw badRequest("That is already the address on this account.");
  }

  const { error } = await supabase.auth.updateUser({ email });
  /**
   * Surfaced as-is. Supabase answers "email address already in use" here, and
   * that is the one thing a caller can act on — but note it is also the one
   * response that discloses whether an account exists, which is why this route
   * requires a session: only someone already signed in can ask.
   */
  if (error) throw badRequest(error.message);

  return NextResponse.json({
    ok: true,
    /**
     * Named `pending`, never `email`, so a screen cannot render it as the
     * account's address. It is not, and will not be until both links are
     * followed.
     */
    pending: email,
    message:
      "Check both inboxes. The change needs confirming from your current address and from the " +
      "new one before it takes effect.",
  });
});
