import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { db, orders } from "@/lib/db";
import { serializeOrders } from "@/lib/queries";

export const GET = handler(async (_req, { params }) => {
  const { id } = await params;
  const orderId = parseInt(id, 10);
  if (!Number.isFinite(orderId)) throw badRequest("order id must be a number");
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw notFound("Order");
  const [serialized] = await serializeOrders([order]);
  return NextResponse.json(serialized);
});
