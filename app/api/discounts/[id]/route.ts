import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { statusOf, usedCount } from "@/lib/commerce/discounts";
import { db, discountRedemptions, discounts } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/discounts/:id` (§18.5) — the discount plus its redemption history.
 *
 * `PATCH`/`DELETE` are `discounts.update` / `discounts.delete` in the registry.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { id } = await params;
    const discountId = Number(id);
    if (!Number.isInteger(discountId)) throw badRequest("discount id must be a number");

    const [discount] = await db
      .select()
      .from(discounts)
      .where(and(eq(discounts.id, discountId), siteScope(orgId, discounts.siteId)))
      .limit(1);
    if (!discount) throw notFound("Discount");

    const redemptions = await db
      .select()
      .from(discountRedemptions)
      .where(eq(discountRedemptions.discountId, discount.id))
      .orderBy(desc(discountRedemptions.createdAt))
      .limit(100);

    const used = await usedCount(discount.id);

    return NextResponse.json({
      ...discount,
      status: statusOf(discount),
      usedCount: used,
      exhausted: discount.usageLimit != null && used >= discount.usageLimit,
      /** What it has actually cost, which is the number a merchant wants. */
      totalDiscountedMinor: redemptions.reduce((s, r) => s + r.amountMinor, 0),
      redemptions: redemptions.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
      startsAt: discount.startsAt?.toISOString() ?? null,
      endsAt: discount.endsAt?.toISOString() ?? null,
      createdAt: discount.createdAt.toISOString(),
      updatedAt: discount.updatedAt.toISOString(),
    });
  },
  { permission: "commerce.read" },
);
