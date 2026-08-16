import { NextResponse } from "next/server";
import { ApiError, badRequest, handler } from "@/lib/api";
import { setUserKind } from "@/lib/auth/admin";
import { ensureCustomerForShopper, readCredentialBody } from "@/lib/auth/shopper";
import { loadStore } from "@/lib/commerce/cart";
import { storefrontUrl } from "@/lib/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { credentialsSchema } from "@/lib/validation";

/**
 * `POST /api/auth/sign-up` on a storefront host (§18.3) — a **shopper** account.
 *
 * Deliberately a separate route from `/api/auth/sign-up`, not a shared one with
 * a flag. The two differ in what they create (a customer record for one store
 * versus an organization), in which `user_kind` they stamp, and in which host
 * the cookie lands on. A single route taking a "kind" parameter would put the
 * staff/shopper boundary in a request body — the one place an attacker controls.
 *
 * Runs server-side (D30): the cookie is written by the `setAll` adapter in
 * `lib/supabase/server.ts`, which stamps `httpOnly` and **no `domain`**, so the
 * session stays on this storefront host and never reaches the dashboard.
 */
export const POST = handler(async (req, { params }) => {
  const { site: slug } = await params;
  const site = await loadStore(slug);

  const { values, isFormPost } = await readCredentialBody(req);
  const account = `${storefrontUrl(site)}/account`;
  const fail = (message: string) =>
    NextResponse.redirect(`${account}?error=${encodeURIComponent(message)}`, { status: 303 });

  const parsed = credentialsSchema.safeParse(values);
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.message ?? "Enter a valid email address and password.";
    if (isFormPost) return fail(message);
    throw badRequest(message);
  }
  const { email, password } = parsed.data;

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new ApiError("INTERNAL", 503, "Accounts are not configured for this store");
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${storefrontUrl(site)}/account`,
      /**
       * Lands in user-writable `user_metadata`, so it is a label rather than a
       * boundary — `setUserKind` below writes the authoritative copy into
       * `app_metadata`, which only the service role can set.
       */
      data: { signup_kind: "customer" },
    },
  });

  if (error) {
    if (isFormPost) return fail(error.message);
    throw badRequest(error.message);
  }
  if (!data.user) {
    if (isFormPost) return fail("Sign-up did not complete. Try again.");
    throw badRequest("Sign-up did not return a user");
  }

  /**
   * The authoritative marker (D32). Without it `userKindOf` treats the account
   * as **staff** — absence means staff by design — and a shopper would be
   * refused by the storefront while being structurally valid for the dashboard,
   * where the membership lookup is what actually stops them.
   */
  // The site is stamped alongside the kind so auth mail can find the merchant
  // whose domain it must send from (§24 Send Email Hook).
  await setUserKind(data.user.id, "customer", site.id);

  /**
   * Creates or links the customer record for *this* store. Returns null while
   * the address is unconfirmed, which is what stops a sign-up claiming a
   * stranger's guest order history by typing their email.
   */
  const customer = await ensureCustomerForShopper(site.id, data.user);

  if (isFormPost) {
    // Confirmation pending is not an error, but it is not "you are in" either —
    // the page needs to say which one happened.
    const note =
      data.session === null
        ? "?notice=" + encodeURIComponent("Check your email to confirm your address.")
        : "";
    return NextResponse.redirect(`${account}${note}`, { status: 303 });
  }

  return NextResponse.json(
    {
      ok: true,
      emailConfirmationRequired: data.session === null,
      /** False until the address is confirmed — say so rather than implying linkage. */
      accountLinked: customer !== null,
    },
    { status: 201 },
  );
});
