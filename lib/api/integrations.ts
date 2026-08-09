import { apiDelete, apiGet, apiPost, apiPut } from "./client";

export type IntegrationStatus = "connected" | "not_connected" | "error";

export type X402Integration = {
  status: IntegrationStatus;
  walletAddress: string | null;
  network?: string;
  message?: string;
};

export type GoogleIntegration = {
  status: IntegrationStatus;
  merchantId: string | null;
  lastSyncAt: string | null;
  message?: string;
};

export type StripeIntegration = {
  status: IntegrationStatus;
  /** Connect Standard (D4) — the merchant keeps their own account. */
  mode: "connect_standard";
  /** The merchant's own `acct_…`. Never a key; Markii is never given one. */
  accountId: string | null;
  /**
   * **The gate for offering the card rail.** Connected is not the same as able
   * to take money — Stripe enables charges only after verification, and a store
   * told it can accept cards in that window fails the shopper at card entry.
   */
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  connectedAt: string | null;
  /** Stripe's own outstanding requirements, when it has named any. */
  requirementsDue: string[];
  message?: string;
};

export type IntegrationsResponse = {
  x402: X402Integration;
  google: GoogleIntegration;
  stripe: StripeIntegration;
};

export type IntegrationProvider = "x402" | "google" | "stripe";

export function getIntegrations(init?: RequestInit) {
  return apiGet<IntegrationsResponse>("/api/integrations", undefined, init);
}

export function putX402(
  body: { walletAddress: string },
  init?: RequestInit,
) {
  return apiPut<X402Integration>("/api/integrations/x402", body, init);
}

export function putGoogle(
  body: { merchantId: string; serviceAccountJson: string },
  init?: RequestInit,
) {
  return apiPut<GoogleIntegration>("/api/integrations/google", body, init);
}

export function syncGoogle(init?: RequestInit) {
  return apiPost<{ synced: number; failed: number }>(
    "/api/integrations/google/sync",
    undefined,
    init,
  );
}

/**
 * @deprecated Prefer `startStripeConnect` from `lib/api/payments` — Stripe is a
 * payment rail, not a catalog integration.
 */
export function startStripeConnect(init?: RequestInit) {
  return apiGet<{ url: string; mode: "connect_standard"; note: string }>(
    "/api/integrations/stripe/connect",
    undefined,
    init,
  );
}

/** Catalog feeds only. Payment rails use `disconnectRail` in `lib/api/payments`. */
export function disconnectIntegration(
  provider: "google",
  init?: RequestInit,
) {
  return apiDelete<{ status: "not_connected" }>(
    `/api/integrations/${provider}`,
    init,
  );
}
