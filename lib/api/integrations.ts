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
  accountId: string | null;
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

export function putStripe(body: { secretKey: string }, init?: RequestInit) {
  return apiPut<StripeIntegration>("/api/integrations/stripe", body, init);
}

export function disconnectIntegration(
  provider: IntegrationProvider,
  init?: RequestInit,
) {
  return apiDelete<{ status: "not_connected" }>(
    `/api/integrations/${provider}`,
    init,
  );
}
