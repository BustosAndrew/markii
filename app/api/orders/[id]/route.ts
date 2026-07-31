import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { siteScope } from "@/lib/tenancy";
import { db, orders } from "@/lib/db";
import { serializeOrders } from "@/lib/queries";

export const GET = orgHandler(async (_req, { params, orgId }) => {
  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (!Number.isFinite(orderId)) throw badRequest("order id must be a number");
  const [order] = await db.select().from(orders).where(and(eq(orders.id, orderId), siteScope(orgId, orders.siteId))).limit(1);
  if (!order) throw notFound("Order");
  const [serialized] = await serializeOrders([order]);
  return NextResponse.json(serialized);
});
