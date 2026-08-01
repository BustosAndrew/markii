import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, notFound, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { customers, db, orders } from "@/lib/db";
import { serializeOrders } from "@/lib/queries";
import { siteScope } from "@/lib/tenancy";

/** `GET /api/customers/:id/orders` (§18.3). */
export const GET = orgHandler(
  async (req, { params, orgId }) => {
    const { id } = await params;
    const customerId = Number(id);
    if (!Number.isInteger(customerId)) throw badRequest("customer id must be a number");

    // Resolved through the customer so the org check happens once, and an
    // unknown customer is a 404 rather than an empty order list.
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), siteScope(orgId, customers.siteId)))
      .limit(1);
    if (!customer) throw notFound("Customer");

    const { page, limit, offset } = pagination(new URL(req.url).searchParams);
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.customerId, customer.id))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);

    return NextResponse.json({ items: await serializeOrders(rows), page, limit });
  },
  { permission: "commerce.read" },
);
