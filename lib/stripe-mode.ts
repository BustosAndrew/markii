import "server-only";

/**
 * Stripe key mode, shared by both directions of money.
 *
 * This lives at `lib/` root rather than inside `billing/` or `payments/` because
 * **both** need it and neither should import the other: `lib/payments/` moves a
 * shopper's money into a merchant's own account (D4), `lib/billing/` is Markii
 * invoicing the merchant, and keeping them independent is what stops a
 * `Stripe-Account` header ever reaching the wrong one.
 */

/**
 * The publishable key Stripe Elements should mount with — **only if it is in the
 * same mode as the secret key**.
 *
 * A `pk_live_…` paired with an `sk_test_…` is the worst kind of misconfiguration
 * available here, because everything server-side succeeds. A real client secret
 * is issued, the browser mounts Elements against the other environment, and the
 * failure lands on a shopper or a merchant who has already typed their card
 * number — Stripe answers "No such payment_intent", which reads as a Markii bug
 * and is unreproducible for anyone whose keys happen to match.
 *
 * Returning `null` on a mismatch collapses it into the same refusal a missing
 * key already gets, which both rails handle by declining to open a payment at
 * all rather than holding stock for one that cannot complete.
 *
 * Restricted keys (`rk_…`) carry the mode the same way secret keys do, so they
 * are read the same way.
 */
export function matchedPublishableKey(): string | null {
  const secret = process.env.STRIPE_SECRET_KEY;
  const publishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!secret || !publishable) return null;
  const secretLive = !secret.startsWith("sk_test") && !secret.startsWith("rk_test");
  const publishableLive = !publishable.startsWith("pk_test");
  return secretLive === publishableLive ? publishable : null;
}
