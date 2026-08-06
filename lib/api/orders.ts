import { apiGet } from "./client";
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

export function listOrders(query?: OrdersQuery, init?: RequestInit) {
  return apiGet<OrdersResponse>("/api/orders", query, init);
}
