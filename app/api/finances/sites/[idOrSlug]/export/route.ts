import { desc, eq } from "drizzle-orm";
import { orgHandler } from "@/lib/auth/handler";
import { db, orders, products } from "@/lib/db";
import { resolveSite, serializeOrders, transactionFilters } from "@/lib/queries";

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const GET = orgHandler(async (req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug, orgId);
  const sp = new URL(req.url).searchParams;

  const rows = await db
    .select({ order: orders })
    .from(orders)
    .leftJoin(products, eq(orders.productId, products.id))
    .where(transactionFilters(site.id, sp))
    .orderBy(desc(orders.createdAt))
    .limit(1000);
  const items = await serializeOrders(rows.map((r) => r.order));

  const header = "id,date,product,quantity,amount,currency,provider,status,tx_hash,agent";
  const lines = items.map((o) =>
    [
      o.id,
      o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
      o.product?.name ?? "",
      o.quantity,
      (o.amountCents / 100).toFixed(2),
      o.currency,
      o.provider,
      o.status,
      o.txHash ?? "",
      o.agent.name,
    ]
      .map(csvCell)
      .join(","),
  );

  return new Response([header, ...lines].join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${site.slug}-transactions.csv"`,
    },
  });
});
