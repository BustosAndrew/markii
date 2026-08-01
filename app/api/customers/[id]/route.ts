import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { customerAddresses, customers, db, orders } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/customers/:id` (§18.3) — the record, its addresses, and derived
 * order totals.
 *
 * `PATCH`/`DELETE` go through `customers.update` / `customers.delete`. Deletion
 * is a `high`-risk action because it is irreversible and privacy-affecting.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { id } = await params;
    const customerId = Number(id);
    if (!Number.isInteger(customerId)) throw badRequest("customer id must be a number");

    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), siteScope(orgId, customers.siteId)))
      .limit(1);
    if (!customer) throw notFound("Customer");

    const addresses = await db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customer.id))
      .orderBy(desc(customerAddresses.isDefault), asc(customerAddresses.id));

    const [stats] = await db
      .select({
        c: count(),
        total: sql<string>`coalesce(sum(${orders.amountCents}), 0)`,
      })
      .from(orders)
      .where(and(eq(orders.customerId, customer.id), eq(orders.status, "success")));

    return NextResponse.json({
      ...customer,
      addresses,
      defaultAddressId: addresses.find((a) => a.isDefault)?.id ?? null,
      ordersCount: Number(stats?.c ?? 0),
      totalSpentMinor: Number(stats?.total ?? 0),
      marketingConsentAt: customer.marketingConsentAt?.toISOString() ?? null,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
    });
  },
  { permission: "commerce.read" },
);
