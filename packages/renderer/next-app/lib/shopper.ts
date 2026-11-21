import "server-only";

/**
 * ─── YOUR SIGN-IN GOES HERE ────────────────────────────────────────────────
 *
 * Who is shopping, as **your** sign-in knows them. This app ships without
 * accounts on purpose: shopper sign-in, its database and its hosting are
 * yours to choose and run (Auth.js, Clerk, Supabase, your own — anything that
 * can tell this server who the shopper is).
 *
 * Return the shopper's email **only once your sign-in has verified it**. With
 * `MARKII_STOREFRONT_KEY` set, Markii takes this address at its word and acts
 * as that customer of your store — their memberships unlock members-only
 * products, and their cart is theirs at checkout. An unverified address here
 * would let anyone shop as anyone.
 *
 * Return null for a guest. Guests can buy everything that is not members-only
 * with no sign-in at all.
 */
export async function currentShopperEmail(): Promise<string | null> {
  return null;
}

/** Where "Account" links go — your sign-in page. Unset, the link goes home. */
export function accountUrl(): string {
  return process.env.ACCOUNT_URL ?? "/";
}
