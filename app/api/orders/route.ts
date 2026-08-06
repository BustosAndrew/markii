import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, dateRange, enumParam, intParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { customers, db, orderLines, orders, products } from "@/lib/db";
import { serializeOrders } from "@/lib/queries";
import { siteScope, siteScopeForStaff } from "@/lib/tenancy";

const STATUSES = ["pending", "success", "cancel", "failed"] as const;
const FINANCIAL_STATUSES = ["pending", "paid", "partially_refunded", "refunded", "voided"] as const;
const FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
  "not_required",
] as const;
const PROVIDERS = ["x402", "stripe"] as const;

/**
 * §13's speculative filters, refused **by name** rather than left unread.
 *
 * Leaving them unread is the same silent no-op as accepting them: a caller
 * asking for `?exception=true` would be handed every order and have no way to
 * know the filter never ran. Each one names what to use instead, or why there is
 * nothing to use.
 */
const UNSUPPORTED_FILTERS: Record<string, string> = {
  channelId: "there is no channel model yet (§11 is planned)",
  environment: "orders carry no test/production flag — test orders are excluded at write time",
  exception: "orders carry no exception column; filter on status or fulfillmentStatus instead",
  paymentRail: "use `provider` (x402 | stripe)",
  paymentStatus: "use `financialStatus`",
};

/**
 * `GET /api/orders` (§13) — the order list behind the Orders screen.
 *
 * **The filters are the columns that exist, not the ones §13 sketched.** That
 * section was written against a planned schema and names `channelId`,
 * `environment`, `paymentRail`, and `exception`; none of them are columns on
 * `orders` today. Accepting them here would mean either ignoring them — a filter
 * that silently matches everything is worse than one that 400s — or deriving
 * them, which is how a merchant ends up reading an "exception" Markii invented.
 * `provider` is the real payment-rail column and is filterable under that name.
 *
 * Reads only. `orders.refund`, `cancel`, `fulfill`, `addNote`, and
 * `resendConfirmation` are invoked through `POST /api/actions/:id` (§22 rule 1).
 */
export const GET = orgHandler(
  async (req, { session, orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);

    for (const [name, why] of Object.entries(UNSUPPORTED_FILTERS)) {
      if (sp.has(name)) throw badRequest(`${name} is not a supported filter: ${why}`);
    }

    // Org scope first and unconditional; every filter below only narrows it.
    // Staff scoped to a subset of stores never see the rest of the org's orders.
    const conds: SQL[] = [siteScopeForStaff(orgId, session.storeIds, orders.siteId)];

    const siteId = intParam(sp, "siteId");
    if (siteId != null) conds.push(eq(orders.siteId, siteId));
    const customerId = intParam(sp, "customerId");
    if (customerId != null) conds.push(eq(orders.customerId, customerId));
    const productId = intParam(sp, "productId");
    if (productId != null) conds.push(eq(orders.productId, productId));

    const status = enumParam(sp, "status", STATUSES);
    if (status) conds.push(eq(orders.status, status));
    const financialStatus = enumParam(sp, "financialStatus", FINANCIAL_STATUSES);
    if (financialStatus) conds.push(eq(orders.financialStatus, financialStatus));
    const fulfillmentStatus = enumParam(sp, "fulfillmentStatus", FULFILLMENT_STATUSES);
    if (fulfillmentStatus) conds.push(eq(orders.fulfillmentStatus, fulfillmentStatus));
    const provider = enumParam(sp, "provider", PROVIDERS);
    if (provider) conds.push(eq(orders.provider, provider));

    const { from, to } = dateRange(sp);
    if (from) conds.push(gte(orders.createdAt, from));
    if (to) conds.push(lte(orders.createdAt, to));

    /**
     * `q` searches what a merchant actually has in hand: the order number from a
     * support email, the buyer's address, the transaction hash, the product
     * name. `orders.email` is the copy frozen at checkout, so it still finds the
     * order after the customer record is erased (§18.3).
     */
    const q = sp.get("q")?.trim();
    if (q) {
      const like = `%${q}%`;
      const terms: SQL[] = [
        ilike(orders.email, like),
        ilike(orders.txHash, like),
        ilike(products.name, like),
        ilike(orders.agentName, like),
      ];
      if (/^\d+$/.test(q)) terms.push(eq(orders.id, Number(q)));
      conds.push(or(...terms)!);
    }

    const where = and(...conds);

    const sortMap: Record<string, SQL> = {
      createdAt: asc(orders.createdAt),
      "-createdAt": desc(orders.createdAt),
      amountCents: asc(orders.amountCents),
      "-amountCents": desc(orders.amountCents),
    };
    const sortKey = sp.get("sort") ?? "-createdAt";
    // Ties on the sort column would otherwise page nondeterministically and show
    // the same order twice — id breaks them.
    const orderBy = [sortMap[sortKey] ?? desc(orders.createdAt), desc(orders.id)];

    /**
     * Totals and the row count come from one grouped pass.
     *
     * **Grouped by currency, never summed across it.** A store selling in USDC
     * and USD has two totals, and adding them produces a number that is not
     * money in any currency (`CLAUDE.md`: explicit currency, no float math).
     *
     * Gross counts `status = 'success'` only. Pending and failed orders are
     * requests, not receipts, and folding them into a revenue figure is exactly
     * the fabricated metric the house rules forbid — `orderCount` still reports
     * every matched row, so a status filter never looks like an empty result.
     */
    const totalsRows = await db
      .select({
        currency: orders.currency,
        orderCount: count(),
        paidOrderCount: sql<string>`count(*) filter (where ${orders.status} = 'success')`,
        grossMinor: sql<string>`coalesce(sum(${orders.amountCents})
          filter (where ${orders.status} = 'success'), 0)`,
        refundedMinor: sql<string>`coalesce(sum(${orders.refundedMinor})
          filter (where ${orders.status} = 'success'), 0)`,
      })
      .from(orders)
      .leftJoin(products, eq(orders.productId, products.id))
      .where(where)
      .groupBy(orders.currency);

    const byCurrency = totalsRows
      .map((r) => {
        const grossMinor = Number(r.grossMinor);
        const refundedMinor = Number(r.refundedMinor);
        return {
          currency: r.currency,
          orderCount: Number(r.orderCount),
          paidOrderCount: Number(r.paidOrderCount),
          grossMinor,
          refundedMinor,
          netMinor: grossMinor - refundedMinor,
        };
      })
      .sort((a, b) => b.grossMinor - a.grossMinor || a.currency.localeCompare(b.currency));
    const total = byCurrency.reduce((n, c) => n + c.orderCount, 0);

    const rows = await db
      .select({ order: orders })
      .from(orders)
      .leftJoin(products, eq(orders.productId, products.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    const items = await serializeOrders(rows.map((r) => r.order));
    const ids = items.map((o) => o.id);

    /**
     * Line counts, one query for the page. The list shows "3 items" without
     * fetching three itemisations, and `itemised: false` is a real state — orders
     * placed before §18.7 have no lines, and counting the legacy `quantity`
     * column as one line would dress them up as something they are not.
     */
    const lineAgg = ids.length
      ? await db
          .select({
            orderId: orderLines.orderId,
            lineCount: count(),
            units: sql<string>`coalesce(sum(${orderLines.quantity}), 0)`,
          })
          .from(orderLines)
          .where(inArray(orderLines.orderId, ids))
          .groupBy(orderLines.orderId)
      : [];
    const linesBy = new Map(lineAgg.map((l) => [l.orderId, l]));

    /**
     * Who bought it, for the rows that know. Scoped again on the way out rather
     * than trusted from the order's own `customerId` — one join is not a reason
     * to leave a tenancy boundary to an invariant elsewhere in the file.
     */
    const customerIds = [
      ...new Set(rows.map((r) => r.order.customerId).filter((id): id is number => id != null)),
    ];
    const customerRows = customerIds.length
      ? await db
          .select({
            id: customers.id,
            email: customers.email,
            firstName: customers.firstName,
            lastName: customers.lastName,
          })
          .from(customers)
          .where(and(inArray(customers.id, customerIds), siteScope(orgId, customers.siteId)))
      : [];
    const customerBy = new Map(customerRows.map((c) => [c.id, c]));

    return NextResponse.json({
      items: items.map((o, i) => {
        const row = rows[i].order;
        const lines = linesBy.get(o.id);
        const customer = row.customerId != null ? customerBy.get(row.customerId) : undefined;
        return {
          ...o,
          customerId: row.customerId,
          customer: customer
            ? {
                id: customer.id,
                email: customer.email,
                name: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || null,
              }
            : null,
          lineCount: lines ? Number(lines.lineCount) : 0,
          unitCount: lines ? Number(lines.units) : 0,
          itemised: lines != null,
          /** What is left to refund, so a list badge need not re-derive it. */
          refundableMinor: Math.max(row.amountCents - row.refundedMinor, 0),
        };
      }),
      total,
      page,
      limit,
      totals: { orderCount: total, byCurrency },
    });
  },
  { permission: "commerce.read" },
);
