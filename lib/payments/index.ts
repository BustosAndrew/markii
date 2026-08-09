import { defaultWallet, getIntegration } from "../integrations";
import { createPaymentIntent } from "./stripe-charges";

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
 * Card data goes only to Stripe-hosted Elements (PCI SAQ-A), charges are created
 * with `Stripe-Account` against the merchant's own account, and Markii takes
 * **no `application_fee_amount`** — merchants keep their own account and Markii
 * never holds their funds (`docs/DECISIONS.md` D4, `docs/PRICING.md`).
 *
 * `account.updated` webhooks keep `chargesEnabled` current per merchant, which
 * is what lets this tell a merchant who has not connected apart from one Stripe
 * has not finished verifying — two different problems with two different fixes.
 */
async function startStripe(
  orgId: string,
  charge?: {
    amountMinor: number;
    currency: string;
    sessionId: string;
    siteId: number;
    email: string | null;
  },
): Promise<PaymentStart> {
  /**
   * Three different "no", and conflating them sends a merchant to fix the wrong
   * thing. Markii's own credentials missing is *our* problem; an unconnected or
   * unverified merchant account is *theirs*; a built-out rail that simply is not
   * written yet is nobody's to fix by configuration.
   */
  if (!stripeConfigured()) {
    return {
      ok: false,
      rail: "stripe",
      code: "unavailable",
      message: "Card payments are not available on this platform yet.",
    };
  }

  const connection = await getIntegration(orgId, "stripe");
  if (connection?.status !== "connected" || !connection.config.accountId) {
    return {
      ok: false,
      rail: "stripe",
      code: "configuration_required",
      message: "Card payments are not available on this store yet.",
      resolution:
        "Connect your Stripe account in Settings → Payments. You keep your own account, rates, " +
        "dashboard, and payouts — Markii never holds funds, never marks up processor fees, and " +
        "takes no cut of your payments.",
    };
  }

  /**
   * **Connected is not the same as able to take money.** Stripe enables charges
   * only once the account clears verification, and a storefront that offers card
   * checkout in that window fails the shopper at the moment they enter their
   * card — after stock was already held for them.
   */
  if (connection.config.chargesEnabled !== "true") {
    const due = connection.config.requirementsDue?.split(",").filter(Boolean) ?? [];
    return {
      ok: false,
      rail: "stripe",
      code: "configuration_required",
      message: "Stripe has not enabled charges on your account yet.",
      resolution: due.length
        ? `Stripe still needs: ${due.join(", ")}. Complete these in your own Stripe dashboard; ` +
          "Markii is told when it is done."
        : "Finish verification in your own Stripe dashboard. Markii is told when it is done.",
    };
  }

  /**
   * Availability only — the caller is asking whether the rail works, not opening
   * a payment. Answering `ok` without instructions would be wrong, so this
   * reports the rail as usable with an empty instruction set only when a charge
   * was actually requested below.
   */
  if (!charge) {
    return { ok: true, rail: "stripe", instructions: { accountId: connection.config.accountId } };
  }

  const intent = await createPaymentIntent({
    accountId: connection.config.accountId,
    amountMinor: charge.amountMinor,
    currency: charge.currency,
    sessionId: charge.sessionId,
    siteId: charge.siteId,
    email: charge.email,
  });
  if (!intent.ok) {
    return { ok: false, rail: "stripe", code: "unavailable", message: intent.reason };
  }
  if (!intent.publishableKey) {
    /**
     * Card details may only ever be entered into Stripe-hosted Elements (PCI
     * SAQ-A), and Elements cannot mount without a publishable key — **or with
     * one from the other mode**. Opening a PaymentIntent the shopper has no way
     * to pay would hold stock for a checkout that cannot finish.
     */
    return {
      ok: false,
      rail: "stripe",
      code: "configuration_required",
      message: "Card payments are not fully configured on this platform.",
      resolution:
        "Card payments need additional platform configuration (publishable key and secret key " +
        "must be in the same mode). Contact your Markii admin.",
    };
  }

  return {
    ok: true,
    rail: "stripe",
    instructions: {
      paymentIntentId: intent.paymentIntentId,
      clientSecret: intent.clientSecret,
      publishableKey: intent.publishableKey,
      accountId: connection.config.accountId,
    },
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
  /**
   * Present when a real payment is being opened; absent when a caller only
   * wants to know whether the rail is usable.
   *
   * **The split matters.** `railStatus` asks about every rail on every
   * storefront render — creating a PaymentIntent there would open an
   * authorisation on a merchant's account for a basket nobody has agreed to buy.
   */
  charge?: {
    amountMinor: number;
    currency: string;
    sessionId: string;
    siteId: number;
    email: string | null;
  };
}): Promise<PaymentStart> {
  return input.rail === "stripe"
    ? startStripe(input.orgId, input.charge)
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
