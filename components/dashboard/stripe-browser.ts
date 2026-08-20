"use client";

import { loadStripe, type Appearance, type Stripe } from "@stripe/stripe-js";

/** Shared Elements look — matches Operate tokens so the card form is not Stripe's default blue. */
export const markiiStripeAppearance: Appearance = {
  theme: "stripe",
  variables: {
    colorPrimary: "#C9184A",
    colorBackground: "#FFFFFF",
    colorText: "#16161D",
    colorDanger: "#C9184A",
    colorTextSecondary: "#6B7280",
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    borderRadius: "12px",
    spacingUnit: "4px",
  },
};

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
