import { NextResponse } from "next/server";
import { invokeAction } from "@/lib/actions";
import { orgHandler } from "@/lib/auth/handler";

/**
 * `POST /api/billing/payment-method` (§17) — a Stripe SetupIntent client secret.
 *
 * **Card data never touches Markii.** The secret is confirmed inside
 * Stripe-hosted Elements in the browser (PCI SAQ-A); nothing here sees, stores,
 * or proxies a card number. This route returns the secret and the publishable
 * key Elements needs to mount, and refuses when either is missing rather than
 * rendering a card form that cannot submit.
 *
 * Delegates to `billing.startPaymentMethodSetup` — no route handler mutates
 * state outside the registry (§22 rule 1), and this creates the platform Stripe
 * Customer on first use.
 *
 * **Collecting a card is not the same as using it.** Elements returns a payment
 * method id, which the client must then pass to `billing.setDefaultPaymentMethod`;
 * without that step the card is attached but not the one invoices are charged
 * to, and the next renewal fails against nothing.
 */
export const POST = orgHandler(
  async (_req, { session }) => {
    const outcome = await invokeAction(
      "billing.startPaymentMethodSetup",
      {},
      { actor: session.actor },
    );
    return NextResponse.json(outcome);
  },
  { permission: "billing.write" },
);
