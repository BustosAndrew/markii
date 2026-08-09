/**
 * Storefront cart + checkout client (§18.4 / §23).
 *
 * Paths are relative to the storefront host. On `{slug}.localhost` / custom
 * domains, `proxy.ts` rewrites `/api/cart` → `/_sites/{slug}/api/cart`.
 * Do not call platform `/api/*` from these helpers.
 */

import { ApiClientError, type ApiErrorBody } from "./types";

const CART_COOKIE = "markii_cart";

export type MoneyComponent = {
  amountMinor: number;
  state: "final" | "provisional" | "not_applicable";
  note?: string | null;
};

export type CartLine = {
  id: number;
  productId: number;
  variantId: number | null;
  title: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  requiresShipping?: boolean;
  imageUrl?: string | null;
};

export type StorefrontCart = {
  token: string;
  storeId: number;
  status: string;
  customerId: number | null;
  email: string | null;
  discountCodes: string[];
  shippingAddress: Record<string, string> | null;
  shippingRateId: number | null;
  currency: string;
  lines: CartLine[];
  subtotalMinor: number;
  discount: MoneyComponent;
  tax: MoneyComponent;
  shipping: MoneyComponent;
  shippingRates: { id: number; name: string; priceMinor: number }[];
  shippingState: string;
  discounts: unknown[];
  rejectedCodes: unknown[];
  totalMinor: number;
  totalState: "final" | "provisional";
  issues: { code: string; reason: string }[];
  expiresAt: string;
  updatedAt: string;
};

export type CheckoutSession = {
  id: string;
  status: string;
  rail: "stripe" | "x402";
  currency: string;
  totalMinor: number;
  amountsAreFinal: boolean;
  payment: {
    paymentIntentId?: string;
    clientSecret?: string;
    publishableKey?: string;
    accountId?: string;
    payTo?: string;
  };
  expiresAt: string;
};

async function parseError(res: Response): Promise<ApiClientError> {
  let code = "INTERNAL";
  let message = res.statusText || "Request failed";
  let details: unknown;
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code || code;
      message = body.error.message || message;
      details = body.error.details;
    }
  } catch {
    // non-JSON
  }
  return new ApiClientError(res.status, code, message, details);
}

async function sfFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function readCartToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${CART_COOKIE}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

export function writeCartToken(token: string) {
  if (typeof document === "undefined") return;
  const maxAge = 14 * 24 * 60 * 60;
  document.cookie = `${CART_COOKIE}=${encodeURIComponent(token)}; path=/; max-age=${maxAge}; samesite=lax`;
}

export function clearCartToken() {
  if (typeof document === "undefined") return;
  document.cookie = `${CART_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function createCart(body?: {
  productId?: number;
  variantId?: number | null;
  quantity?: number;
}) {
  return sfFetch<StorefrontCart>("/api/cart", {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function getCart(token: string) {
  return sfFetch<StorefrontCart>(`/api/cart/${encodeURIComponent(token)}`);
}

export function patchCart(
  token: string,
  body: {
    add?: { productId: number; variantId?: number | null; quantity?: number };
    setQuantity?: { lineId: number; quantity: number };
    email?: string;
    shippingAddress?: Record<string, string>;
    shippingRateId?: number | null;
  },
) {
  return sfFetch<StorefrontCart>(`/api/cart/${encodeURIComponent(token)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function applyDiscount(token: string, code: string) {
  return sfFetch<StorefrontCart>(`/api/cart/${encodeURIComponent(token)}/discount`, {
    method: "POST",
    body: JSON.stringify({ code, action: "apply" }),
  });
}

export function removeDiscount(token: string, code: string) {
  return sfFetch<StorefrontCart>(`/api/cart/${encodeURIComponent(token)}/discount`, {
    method: "POST",
    body: JSON.stringify({ code, action: "remove" }),
  });
}

export function quoteShippingRates(
  token: string,
  body?: { address?: Record<string, string>; save?: boolean },
) {
  return sfFetch<{
    state: string;
    rates: { id: number; name: string; priceMinor: number }[];
    selectedRateId: number | null;
    reason?: string;
  }>(`/api/cart/${encodeURIComponent(token)}/shipping-rates`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function createCheckoutSession(body: {
  cartToken: string;
  rail: "stripe" | "x402";
  email?: string;
}) {
  return sfFetch<CheckoutSession>("/api/checkout/session", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function completeCheckoutSession(
  sessionId: string,
  body: { paymentReference: string; payerReference?: string },
) {
  return sfFetch<{ ok: true; orderId: number; alreadyCompleted?: boolean }>(
    `/api/checkout/session/${encodeURIComponent(sessionId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

/** Ensure a cart token exists, optionally seeding the first line. */
export async function ensureCart(seed?: {
  productId: number;
  variantId?: number | null;
  quantity?: number;
}): Promise<StorefrontCart> {
  const existing = readCartToken();
  if (existing && !seed) {
    try {
      return await getCart(existing);
    } catch {
      clearCartToken();
    }
  }
  if (existing && seed) {
    try {
      const cart = await patchCart(existing, {
        add: {
          productId: seed.productId,
          variantId: seed.variantId,
          quantity: seed.quantity ?? 1,
        },
      });
      writeCartToken(cart.token);
      return cart;
    } catch {
      clearCartToken();
    }
  }
  const cart = await createCart(seed);
  writeCartToken(cart.token);
  return cart;
}
