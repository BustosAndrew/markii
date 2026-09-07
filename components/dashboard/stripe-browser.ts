"use client";

import { loadStripe, type Appearance, type Stripe } from "@stripe/stripe-js";

/**
 * Stripe Elements runs in an iframe and **cannot read this page's CSS variables**.
 * `var(--font-geist-sans)` is invisible there, so the iframe falls back to the
 * browser default — Times New Roman. A concrete system stack is what it can
 * actually render.
 */
const STRIPE_FONT =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Shared Elements look — matches Operate tokens so the card form is not Stripe's default blue. */
export const markiiStripeAppearance: Appearance = {
  theme: "stripe",
  variables: {
    colorPrimary: "#C9184A",
    colorBackground: "#FFFFFF",
    colorText: "#16161D",
    colorDanger: "#C9184A",
    colorTextSecondary: "#6B7280",
    fontFamily: STRIPE_FONT,
    borderRadius: "12px",
    spacingUnit: "4px",
  },
  rules: {
    ".Input": { fontFamily: STRIPE_FONT },
    ".Label": { fontFamily: STRIPE_FONT },
    ".Tab": { fontFamily: STRIPE_FONT },
    ".TabLabel": { fontFamily: STRIPE_FONT },
    ".Error": { fontFamily: STRIPE_FONT },
    ".Block": { fontFamily: STRIPE_FONT },
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
