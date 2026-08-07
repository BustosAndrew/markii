import { apiGet, buildQuery } from "./client";
import type { Order } from "./types";

/**
 * Orders service (§13). Reads only — every order mutation is a registry action
 * (`orders.refund`, `orders.cancel`, `orders.fulfill`, `orders.addNote`,
 * `orders.resendConfirmation`) invoked through `lib/api/actions.ts`.
 */

export type OrderListItem = Order & {
  customerId: number | null;
  customer: { id: number; email: string; name: string | null } | null;
  /**
   * `itemised: false` means the order predates §18.7 and has no lines — show it
   * as unknown, not as one line of `quantity`. `GET /api/orders/:id` says the
   * same thing about the same orders.
   */
  itemised: boolean;
  lineCount: number;
  unitCount: number;
  refundableMinor: number;
};

/**
 * Totals for the **filtered set**, grouped by currency and never summed across
 * it: a store selling in USDC and USD has two totals, and one merged number
 * would not be money in either. Render one row per currency.
 *
 * `grossMinor` counts successful orders only — `orderCount` still covers every
 * matched row, so a pending-only filter shows its rows with a zero gross rather
 * than looking empty.
 */
export type OrderTotals = {
  orderCount: number;
  byCurrency: {
    currency: string;
    orderCount: number;
    paidOrderCount: number;
    grossMinor: number;
    refundedMinor: number;
    netMinor: number;
  }[];
};

export type OrdersResponse = {
  items: OrderListItem[];
  total: number;
  page: number;
  limit: number;
  totals: OrderTotals;
};

/**
 * The filters the route actually supports. §13 also sketches `channelId`,
 * `environment`, and `exception`; none of those are columns on `orders`, and the
 * route answers 400 rather than pretending to filter on them.
 */
export type OrdersQuery = {
  q?: string;
  siteId?: number;
  customerId?: number;
  productId?: number;
  status?: Order["status"];
  financialStatus?: Order["financialStatus"];
  fulfillmentStatus?: Order["fulfillmentStatus"];
  /** The payment rail. x402 and Stripe are peers — label whichever is shown. */
  provider?: Order["provider"];
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  sort?: "-createdAt" | "createdAt" | "amountCents" | "-amountCents";
};

/** A line as sold — a snapshot, not a join against today's catalog. */
export type OrderLine = {
  id: number;
  orderId: number;
  productId: number | null;
  variantId: number | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unitPriceMinor: number;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  addOns: { productId: number; name: string; unitPriceMinor: number }[];
  quantityRefunded: number;
  quantityFulfilled: number;
  /** Pre-derived by the API so a screen cannot compute them differently. */
  quantityRefundable: number;
  quantityUnfulfilled: number;
  locationId: number | null;
  createdAt: string;
};

export type OrderRefund = {
  id: number;
  orderId: number;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  amountMinor: number;
  netSalesMinor: number;
  currency: string;
  reason: "requested_by_customer" | "duplicate" | "fraudulent" | "item_unavailable" | "other";
  note: string | null;
  restock: boolean;
  /** `manual` — the merchant sent the money. `processor` — a rail did. */
  method: "manual" | "processor";
  rail: "stripe" | "x402" | "manual" | "external";
  processorReference: string | null;
  lines: { id: number; refundId: number; orderLineId: number; quantity: number }[];
  /**
   * `true` when Markii issued this refund on the card rail, `false` when the
   * merchant moved the money and Markii recorded it — the only possibility on
   * x402, whose settlement is irreversible (§18.7).
   *
   * **Read it rather than assuming either way.** The two look identical in a
   * list and are not the same event, and Markii never holds merchant funds in
   * either case: a card refund comes out of the merchant's own Stripe balance.
   */
  moneyMovedByMarkii: boolean;
  createdAt: string;
};

export type OrderFulfillment = {
  id: number;
  orderId: number;
  status: "pending" | "shipped" | "delivered" | "cancelled";
  trackingNumber: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  notifiedCustomer: boolean;
  note: string | null;
  lines: { id: number; fulfillmentId: number; orderLineId: number; quantity: number }[];
  /** Always `false`: Markii does no carrier integration (`docs/PLAN.md` §3). */
  trackingVerified: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OrderEvent = {
  id: number;
  orderId: number;
  type:
    | "placed"
    | "note"
    | "refunded"
    | "cancelled"
    | "fulfilled"
    | "fulfillment_updated"
    | "email_sent"
    | "email_failed";
  message: string;
  data: Record<string, unknown>;
  visibility: "internal" | "customer";
  actorType: "user" | "agent" | "token" | "system";
  actorLabel: string | null;
  createdAt: string;
};

/** §18.8. The grant's token is deliberately absent — it is the buyer's credential. */
export type OrderDownload = {
  id: number;
  fileName: string;
  sizeBytes: number;
  downloadsUsed: number;
  downloadLimit: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  lastDownloadedAt: string | null;
  redeemable: boolean;
  createdAt: string;
};

export type OrderLicenceKey = {
  id: number;
  key: string;
  productId: number | null;
  assignedAt: string | null;
  revokedAt: string | null;
};

/** What `GET /api/orders/:id` returns: the whole order in one response. */
export type OrderDetail = Order & {
  customerId: number | null;
  /** Null for guest and agent-placed orders — `email` still carries the buyer. */
  customer: { id: number; email: string; name: string | null } | null;
  lines: OrderLine[];
  /**
   * `false` for orders placed before §18.7 and the earliest x402 orders. They
   * were never itemised, and inventing lines from today's catalog would show a
   * merchant prices nobody paid.
   */
  itemised: boolean;
  refunds: OrderRefund[];
  fulfillments: OrderFulfillment[];
  timeline: OrderEvent[];
  downloads: OrderDownload[];
  licenceKeys: OrderLicenceKey[];
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    shippingMinor: number;
    totalMinor: number;
    refundedMinor: number;
    refundableMinor: number;
    currency: string;
  };
};

export function listOrders(query?: OrdersQuery, init?: RequestInit) {
  return apiGet<OrdersResponse>("/api/orders", query, init);
}

export function getOrder(id: number, init?: RequestInit) {
  return apiGet<OrderDetail>(`/api/orders/${id}`, undefined, init);
}

/**
 * A download URL, not a fetch — the browser needs to navigate to it for the
 * `content-disposition` attachment to land as a file.
 *
 * Pass the **same filters the screen is showing**; the route applies them from
 * the same builder, so the file matches the list. Over 10,000 rows it answers
 * 400 rather than handing back a truncated ledger, so a link that opens in a new
 * tab should be prepared to surface that error.
 */
export function ordersExportUrl(query?: Omit<OrdersQuery, "page" | "limit" | "sort">) {
  return `/api/orders/export${buildQuery(query)}`;
}
