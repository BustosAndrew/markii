import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { appUrl } from "@/lib/api";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * `GET /api/auth/callback` — exchanges an emailed code for a session, then
 * redirects. Confirmation, recovery, and any future OAuth land here (§16).
 */

/**
 * Only same-origin relative paths. A `next` taken straight from the query string
 * is a textbook open redirect, and this one is reached *while establishing a
 * session* — the most valuable moment to send someone to a convincing fake.
 *
 * Rejects anything with a scheme or authority, including protocol-relative
 * `//evil.com` and backslash variants browsers normalize to slashes.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/dashboard";
  const path = raw.replace(/\\/g, "/");
  if (!path.startsWith("/") || path.startsWith("//")) return "/dashboard";
  return path;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const failure = new URL("/sign-in?error=auth-callback-failed", appUrl());

  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.redirect(failure);

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  try {
    if (code) {
      // PKCE flow.
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
    } else if (tokenHash && type) {
      // Older email-OTP links. Supabase emits one shape or the other depending
      // on project configuration, and a link that arrives in the wrong shape is
      // indistinguishable from an expired one to the person clicking it.
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) throw error;
    } else {
      return NextResponse.redirect(failure);
    }
  } catch (e) {
    console.error("auth callback failed", e);
    return NextResponse.redirect(failure);
  }

  return NextResponse.redirect(new URL(next, appUrl()));
}
