import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";

/**
 * `POST /api/billing/payment-method` (§17) — a Stripe SetupIntent client secret.
 *
 * Refuses cleanly rather than returning a stub. A fake client secret would fail
 * inside Stripe's own card element, after the merchant had typed their card
 * number — the worst possible moment to discover the integration does not
 * exist.
 *
 * When this lands, card data still goes only to Stripe-hosted elements
 * (PCI SAQ-A) and never touches Markii.
 */
export const POST = orgHandler(
  async () =>
    NextResponse.json(
      {
        error: {
          code: "CONFIGURATION_REQUIRED",
          message: "Card details cannot be collected — Stripe Billing is not connected.",
          details: {
            resolution:
              "Set STRIPE_SECRET_KEY and configure Stripe Billing (docs/API.md §17).",
            note:
              "Nothing is currently being charged, so no payment method is needed. Threshold " +
              "fees accrue and display on /api/billing/usage.",
          },
        },
      },
      { status: 503 },
    ),
  { permission: "billing.write" },
);
