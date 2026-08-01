import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { evaluateDiscounts } from "@/lib/commerce/discounts";
import { db, sites } from "@/lib/db";
import { ownSites } from "@/lib/tenancy";

/**
 * `POST /api/discounts/validate` (§18.5) — would this code apply, and for how
 * much?
 *
 * A **preview**: it writes nothing, redeems nothing, and consumes no usage
 * allowance. It runs the same `evaluateDiscounts` the cart and checkout use, so
 * a merchant testing a code sees exactly what a shopper would — a second
 * implementation here could disagree with the one that charges money.
 */
const schema = z.object({
  siteId: z.number().int().positive(),
  codes: z.array(z.string().min(1).max(60)).min(1).max(10),
  /** The hypothetical cart. Lines are optional for an order-scoped check. */
  subtotalMinor: z.number().int().min(0),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        lineTotalMinor: z.number().int().min(0),
      }),
    )
    .max(200)
    .default([]),
  customerId: z.number().int().positive().nullish(),
});

export const POST = orgHandler(
  async (req, { orgId }) => {
    const input = schema.parse(JSON.parse((await req.text()) || "{}"));

    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, input.siteId), ownSites(orgId)))
      .limit(1);
    if (!site) throw badRequest("Unknown store");

    /**
     * With no lines supplied, treat the subtotal as one notional line so
     * order-scoped discounts still evaluate. Product- and collection-scoped ones
     * will correctly find nothing to match — which is the honest answer to
     * "would this apply?" when no products were named.
     */
    const lines =
      input.lines.length > 0
        ? input.lines
        : [{ productId: -1, lineTotalMinor: input.subtotalMinor }];

    const result = await evaluateDiscounts({
      siteId: input.siteId,
      codes: input.codes,
      lines,
      subtotalMinor: input.subtotalMinor,
      customerId: input.customerId ?? null,
    });

    return NextResponse.json({
      ...result,
      subtotalMinor: input.subtotalMinor,
      subtotalAfterDiscountMinor: input.subtotalMinor - result.totalDiscountMinor,
      preview: true,
    });
  },
  { permission: "commerce.read" },
);
