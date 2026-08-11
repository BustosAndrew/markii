export type SiteStatus = "draft" | "live" | "paused";

export type ThemeId = "studio" | "atlas" | "noir" | "bloom";

export const THEME_IDS: ThemeId[] = ["studio", "atlas", "noir", "bloom"];

export const THEME_LABELS: Record<ThemeId, string> = {
  studio: "Studio",
  atlas: "Atlas",
  noir: "Noir",
  bloom: "Bloom",
};

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IMPORT_FAILED"
  | "INTERNAL";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode | string;
    message: string;
    /** Object for MFA gates; arrays for validation issues. */
    details?: unknown;
  };
};

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
};

export type Site = {
  id: number;
  name: string;
  slug: string;
  customDomain: string | null;
  status: SiteStatus;
  themeId: ThemeId;
  indexed: boolean;
  agentDiscovery: boolean;
  purchasesEnabled: boolean;
  paymentProviders: { x402: boolean; stripe: boolean };
  walletAddress: string | null;
  googleSiteVerification: string | null;
  productCount: number;
  categoryCount: number;
  storefrontUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type Category = {
  id: number;
  siteId: number;
  parentId: number | null;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  enabled: boolean;
  productCount: number;
  site?: { id: number; name: string; slug: string };
  parent?: { id: number; name: string; slug: string } | null;
  children?: { id: number; name: string; slug: string }[];
  createdAt: string;
  updatedAt: string;
};

export type Product = {
  id: number;
  siteId: number;
  categoryId: number | null;
  name: string;
  slug: string;
  description: string | null;
  priceCents: number;
  currency: string;
  sku: string | null;
  stock: number;
  downloadLimit: number | null;
  downloadExpiryDays: number | null;
  requiresTierId: number | null;
  grantsTierId: number | null;
  grantsDurationDays: number | null;
  grantsRenewalInterval: "none" | "month" | "year";
  images: string[];
  enabled: boolean;
  suggestedProductIds: number[];
  addOns: { productId: number; mandatory: boolean }[];
  digitalAssets?: {
    attachmentId: number;
    assetId: number;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    label: string | null;
    variantId: number | null;
    position: number;
  }[];
  site?: { id: number; name: string; slug: string };
  category?: {
    id: number;
    name: string;
    slug: string;
    parentId: number | null;
  } | null;
  suggestedProducts?: {
    id: number;
    name: string;
    slug: string;
    priceCents: number;
    images: string[];
  }[];
  createdAt: string;
  updatedAt: string;
};

export type Order = {
  id: number;
  // null once the referenced site/product has been deleted (order history is kept)
  siteId: number | null;
  productId: number | null;
  quantity: number;
  status: "pending" | "success" | "cancel" | "failed";
  amountCents: number;
  currency: string;
  provider: "x402" | "stripe";
  txHash: string | null;
  /**
   * §18.7. Money and fulfillment are separate axes from `status`, which keeps
   * its v1 meaning (the payment outcome) — a refunded order is still
   * `status: "success"`, with `financialStatus: "refunded"` beside it.
   */
  financialStatus: "pending" | "paid" | "partially_refunded" | "refunded" | "voided";
  fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled" | "not_required";
  /** Minor units, in `currency`. Never format with a hardcoded `/100` (D31). */
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  refundedMinor: number;
  email: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  agent: {
    userAgent: string;
    name: string;
    walletAddress: string | null;
  };
  product: { id: number; name: string; slug: string } | null;
  site: { id: number; name: string; slug: string } | null;
  createdAt: string;
};

export type OverviewResponse = {
  sites: {
    total: number;
    live: number;
    draft: number;
    paused: number;
  };
  traffic: {
    total: number;
    last7d: number;
    byDay: { date: string; count: number }[];
    topAgents: { agentName: string; count: number }[];
  };
  finances: {
    totalBalanceCents: number;
    x402BalanceCents: number;
    fiatBalanceCents: number;
    orderCount: number;
    bySite: {
      siteId: number;
      siteName: string;
      siteSlug: string;
      balanceCents: number;
    }[];
  };
};

export class ApiClientError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
