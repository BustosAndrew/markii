import { NextResponse } from "next/server";
import { ApiError, handler, unauthorized } from "@/lib/api";
import {
  ensureCustomerForShopper,
  isShopperUser,
  readCredentialBody,
} from "@/lib/auth/shopper";
import { loadStore } from "@/lib/commerce/cart";
import { storefrontUrl } from "@/lib/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { credentialsSchema } from "@/lib/validation";

/**
 * `POST /api/auth/sign-in` on a storefront host (§18.3) — shopper sign-in.
 *
 * **A staff account cannot sign in here, and that is intentional.** One auth
 * user has exactly one `user_kind`, so a merchant cannot also be a shopper on
 * their own store with the same address — they use a different one to test-buy.
 * The alternative, letting a session be either kind depending on which host it
 * was created on, would make the storefront/dashboard boundary depend on request
 * routing rather than on a stamped claim.
 */
export const POST = handler(async (req, { params }) => {
  const { site: slug } = await params;
  const site = await loadStore(slug);

  const { values, isFormPost } = await readCredentialBody(req);
  const account = `${storefrontUrl(site)}/account`;

  /**
   * A plain form post gets a redirect, not JSON — there is no JavaScript on the
   * account page to interpret a response body. Failures come back as a query
   * parameter the page renders, which keeps the whole flow inside server-
   * rendered HTML.
   */
  const fail = (message: string) =>
    NextResponse.redirect(`${account}?error=${encodeURIComponent(message)}`, { status: 303 });

  const parsed = credentialsSchema.safeParse(values);
  if (!parsed.success) {
    if (isFormPost) return fail("Enter a valid email address and password.");
    throw unauthorized("Invalid email or password");
  }
  const { email, password } = parsed.data;

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new ApiError("INTERNAL", 503, "Accounts are not configured for this store");
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    // One message for a wrong password and an unknown address alike — telling
    // them apart turns this form into an account-enumeration oracle, which on a
    // storefront also leaks who shops here.
    if (isFormPost) return fail("Invalid email or password.");
    throw unauthorized("Invalid email or password");
  }

  if (!isShopperUser(data.user)) {
    /**
     * A staff session must not be left behind on a storefront host. Sign the
     * user back out before refusing, or the cookie the adapter just wrote would
     * sit on the shop's origin — exactly where merchant custom code runs.
     */
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("[shopper-auth] failed to clear a staff session", e);
    }
    if (isFormPost) return fail("Invalid email or password.");
    throw unauthorized("Invalid email or password");
  }

  const customer = await ensureCustomerForShopper(site.id, data.user);

  if (isFormPost) return NextResponse.redirect(account, { status: 303 });

  return NextResponse.json({
    ok: true,
    /**
     * False when the address is not confirmed yet: the shopper is signed in but
     * holds no customer record here, so memberships and order history will read
     * as empty. Saying so beats rendering an account page that looks wiped.
     */
    accountLinked: customer !== null,
  });
});
