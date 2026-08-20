"use client";

import { loadStripe, type Stripe } from "@stripe/stripe-js";

const stripeCache = new Map<string, Promise<Stripe | null>>();

/**
 * Stripe.js keyed by the **server-returned** publishable key.
 *
 * Never read `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` here — the billing and
 * checkout APIs refuse when that key is in a different mode from the secret,
 * and handing back the key they validated is how they tell the browser which
 * one is safe to mount.
 */
export function stripePromiseFor(publishableKey: string) {
  if (!publishableKey.startsWith("pk_")) {
    return Promise.resolve(null);
  }
  let cached = stripeCache.get(publishableKey);
  if (!cached) {
    cached = loadStripe(publishableKey);
    stripeCache.set(publishableKey, cached);
  }
  return cached;
}
