import { defaultWallet } from "../integrations";

/**
 * Payment rails (§18.4).
 *
 * **Rails are peers** (`CLAUDE.md`): x402/USDC, card, Stripe, and PayPal are
 * options, not a hierarchy, and each is labelled explicitly wherever a payment
 * appears. x402 is the one that works end-to-end today, which makes it the
 * default demo path and nothing more.
 *
 * The point of this module is the seam. `startPayment` returns either
 * instructions a shopper can act on or an explicit *configuration required* —
 * never a fabricated success. A checkout that returned a client secret it did
 * not have would fail at the worst possible moment, holding stock and telling
 * the shopper their order was placed.
 */

export type PaymentRail = "stripe" | "x402";

export type PaymentStart =
  | {
      ok: true;
      rail: PaymentRail;
      /** Everything the client needs to pay. Shape is rail-specific by design. */
      instructions: Record<string, unknown>;
    }
  | {
      ok: false;
      rail: PaymentRail;
      /** `configuration_required` is a merchant task; `unavailable` is ours. */
      code: "configuration_required" | "unavailable";
      message: string;
      /** What the merchant has to do, when it is their side that is missing. */
      resolution?: string;
    };

/** True when Markii's own Stripe credentials exist. Merchant connection is separate. */
export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Card payments via Stripe Connect Standard.
 *
 * Not wired: `STRIPE_SECRET_KEY` does not exist in this environment yet, so
 * there is no PaymentIntent to create and this reports exactly that. When it
 * lands, card data still goes only to Stripe-hosted elements (PCI SAQ-A) and
 * Markii takes **no `application_fee_amount`** — merchants keep their own
 * account and Markii never holds their funds (`docs/DECISIONS.md`,
 * `docs/PRICING.md`).
 */
async function startStripe(): Promise<PaymentStart> {
  if (!stripeConfigured()) {
    return {
      ok: false,
      rail: "stripe",
      code: "configuration_required",
      message: "Card payments are not available on this store yet.",
      resolution:
        "Connect a Stripe account in Settings → Payments. Markii never holds funds or marks up " +
        "processor fees; Stripe's fee is Stripe's.",
    };
  }
  // Deliberately not stubbed further. A fake client secret would fail at the
  // moment the shopper enters card details, after stock was already held.
  return {
    ok: false,
    rail: "stripe",
    code: "unavailable",
    message: "Card checkout is not implemented yet (docs/API.md §18.4).",
  };
}

/**
 * The x402 rail: the shopper's agent pays on-chain, then presents the
 * transaction hash. The challenge itself is built by the storefront route,
 * which owns the resource URL; this only resolves where the money goes.
 */
async function startX402(orgId: string, siteWallet: string | null): Promise<PaymentStart> {
  const payTo = siteWallet ?? (await defaultWallet(orgId));
  if (!payTo) {
    return {
      ok: false,
      rail: "x402",
      code: "configuration_required",
      message: "This store has no receiving wallet configured.",
      resolution: "Add a receiving wallet address in Settings → Payments.",
    };
  }
  return { ok: true, rail: "x402", instructions: { payTo } };
}

export async function startPayment(input: {
  rail: PaymentRail;
  orgId: string;
  siteWallet: string | null;
}): Promise<PaymentStart> {
  return input.rail === "stripe"
    ? startStripe()
    : startX402(input.orgId, input.siteWallet);
}

/** Rails a store can actually take money on right now, with why-not for the rest. */
export async function railStatus(input: {
  orgId: string;
  siteWallet: string | null;
  enabled: { x402: boolean; stripe: boolean };
}): Promise<{ rail: PaymentRail; available: boolean; reason?: string }[]> {
  const out: { rail: PaymentRail; available: boolean; reason?: string }[] = [];

  for (const rail of ["x402", "stripe"] as const) {
    if (!input.enabled[rail]) {
      out.push({ rail, available: false, reason: "Disabled for this store." });
      continue;
    }
    const start = await startPayment({ rail, orgId: input.orgId, siteWallet: input.siteWallet });
    out.push(
      start.ok
        ? { rail, available: true }
        : { rail, available: false, reason: start.message },
    );
  }
  return out;
}
