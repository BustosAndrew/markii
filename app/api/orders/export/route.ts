import { count, desc, eq } from "drizzle-orm";
import { badRequest } from "@/lib/api";
import { decimalMinor } from "@/lib/api/money";
import { orgHandler } from "@/lib/auth/handler";
import { db, orders, products } from "@/lib/db";
import { orderListFilters, serializeOrders } from "@/lib/queries";

/**
 * How many rows one export may contain.
 *
 * Past this the route **refuses** rather than truncating. A CSV cut off at row
 * 10,000 is indistinguishable from a complete one — the merchant reconciling
 * their books has no way to see what is missing, and this is the file that ends
 * up in an accountant's inbox. Streaming instead would only move the problem: a
 * stream that hits the function timeout also arrives looking finished.
 */
const MAX_EXPORT_ROWS = 10_000;

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const COLUMNS = [
  "id",
  "created_at",
  "site",
  "status",
  "financial_status",
  "fulfillment_status",
  "payment_rail",
  "currency",
  "subtotal",
  "discount",
  "tax",
  "shipping",
  "total",
  "refunded",
  "email",
  "product",
  "quantity",
  "tx_hash",
  "agent",
] as const;

/**
 * `GET /api/orders/export` (§13) — the order list as `text/csv`.
 *
 * Same filters as `GET /api/orders`, from the same builder, so the file matches
 * the screen it was launched from.
 *
 * **Money is written per row against its own currency's exponent** (D31), never
 * a `/100`: a JPY order has no decimal places and a two-decimal cell would
 * inflate it a hundredfold in whatever the merchant imports this into. Amounts
 * are plain decimals with no symbol or grouping — `$1,523.00` is two columns in
 * a comma-separated file.
 */
export const GET = orgHandler(
  async (req, { session, orgId }) => {
    const sp = new URL(req.url).searchParams;
    const where = orderListFilters({ orgId, storeIds: session.storeIds }, sp);

    const [countRow] = await db
      .select({ c: count() })
      .from(orders)
      .leftJoin(products, eq(orders.productId, products.id))
      .where(where);
    const total = Number(countRow?.c ?? 0);
    if (total > MAX_EXPORT_ROWS) {
      throw badRequest(
        `This export would contain ${total.toLocaleString("en-US")} orders, over the ` +
          `${MAX_EXPORT_ROWS.toLocaleString("en-US")} limit. Narrow it with from/to or siteId — ` +
          `a truncated CSV would look complete.`,
      );
    }

    const rows = await db
      .select({ order: orders })
      .from(orders)
      .leftJoin(products, eq(orders.productId, products.id))
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(MAX_EXPORT_ROWS);
    const items = await serializeOrders(rows.map((r) => r.order));

    const lines = items.map((o) => {
      const money = (minor: number) => decimalMinor(minor, o.currency);
      return [
        o.id,
        o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
        o.site?.name ?? "",
        o.status,
        o.financialStatus,
        o.fulfillmentStatus,
        /** The rail, named. x402 and Stripe are peers, never "payment method". */
        o.provider,
        o.currency,
        money(o.subtotalMinor),
        money(o.discountMinor),
        money(o.taxMinor),
        money(o.shippingMinor),
        money(o.amountCents),
        money(o.refundedMinor),
        o.email ?? "",
        o.product?.name ?? "",
        o.quantity,
        o.txHash ?? "",
        o.agent.name,
      ]
        .map(csvCell)
        .join(",");
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response([COLUMNS.join(","), ...lines].join("\r\n") + "\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="markii-orders-${stamp}.csv"`,
        /** Never a shared cache: this is one org's ledger. */
        "cache-control": "private, no-store",
      },
    });
  },
  { permission: "commerce.read" },
);
