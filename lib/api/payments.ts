import { apiDelete, apiGet, apiPut } from "./client";

/**
 * Payment rails (§8) — the Payments screen.
 *
 * **Separate from `lib/api/integrations.ts` on purpose.** Rails decide where a
 * merchant's money is paid; catalog feeds publish products. They shared an
 * endpoint and an action until 2026-08-08, which meant connecting a Google
 * product feed required `billing.write` and a fresh MFA challenge — rules sized
 * for the wallet address sitting next to it.
 *
 * Changing a rail needs **owner or administrator** and a **step-up MFA
 * challenge**, so any screen calling `connectRail` / `disconnectRail` must be
 * ready to handle `403 MFA_REQUIRED` and retry after the code — see
 * `lib/api/mfa-errors.ts`.
 */

export type PaymentRail = "x402" | "stripe";

export type RailStatus = {
  rail: PaymentRail;
  status: "connected" | "not_connected" | "error";
  /**
   * **Gate the storefront on this, not on `status`.** Stripe enables charges
   * only after verification, so a connected account can still be unable to take
   * a penny — and a store told it accepts cards in that window fails the shopper
   * at card entry.
   */
  canAcceptPayments: boolean;
  walletAddress?: string | null;
  accountId?: string | null;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  requirementsDue?: string[];
  message?: string;
};

export type PaymentsResponse = {
  rails: RailStatus[];
  /** Per-store: a rail can be live at the org and switched off for one storefront. */
  stores: {
    id: number;
    slug: string;
    name: string;
    enabled: { x402: boolean; stripe: boolean };
    walletAddressOverride: string | null;
  }[];
  /**
   * **Always null, and that is the answer rather than a gap.** Markii never
   * holds merchant funds (D4) and uses Connect Standard, so balances and payouts
   * belong to the merchant's own Stripe dashboard — restating them here would
   * publish a number Markii does not own and cannot keep in step. x402 has no
   * balance at all; it settles on-chain to their wallet.
   *
   * Render `balancesNote` and link out. What Markii *does* own — orders, net
   * sales, refunds across every rail, the threshold meter — is under Orders →
   * Settlements and `getBillingUsage()`.
   */
  balances: null;
  balancesNote: string;
};

export function getPayments(init?: RequestInit) {
  return apiGet<PaymentsResponse>("/api/payments", undefined, init);
}

/**
 * Set where payments are received. **Requires step-up MFA** — expect
 * `403 MFA_REQUIRED`, prompt for the code, then retry.
 *
 * Stripe is not configured here; it connects through OAuth
 * (`startStripeConnect`), because Markii never accepts a merchant's secret key.
 */
export function connectRail(
  rail: "x402",
  config: { walletAddress: string },
  init?: RequestInit,
) {
  return apiPut<RailStatus>(`/api/integrations/${rail}`, config, init);
}

/** Stop accepting payments on a rail. **Requires step-up MFA.** */
export function disconnectRail(rail: PaymentRail, init?: RequestInit) {
  return apiDelete<RailStatus>(`/api/integrations/${rail}`, init);
}
