import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { loadStore } from "@/lib/commerce/cart";
import { storefrontUrl } from "@/lib/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/** `POST /api/auth/sign-out` on a storefront host (§18.3) — ends a shopper session. */
export const POST = handler(async (req, { params }) => {
  const { site: slug } = await params;
  const site = await loadStore(slug);
  const supabase = await getSupabaseServerClient();

  // Signing out must succeed even if the revoke call does not: a Supabase
  // outage otherwise leaves a shopper unable to end their session on a shared
  // machine, which is the one moment this button really matters.
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("[shopper-auth] sign-out revoke failed", e);
    }
  }

  // The account page signs out with a plain form, so a redirect is the response
  // that flow can actually use.
  if ((req.headers.get("content-type") ?? "").includes("form")) {
    return NextResponse.redirect(`${storefrontUrl(site)}/account`, { status: 303 });
  }

  return NextResponse.json({ ok: true });
});
