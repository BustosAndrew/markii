import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { calculateTax } from "@/lib/commerce/tax";
import { db, sites } from "@/lib/db";
import { ownSites } from "@/lib/tenancy";

/**
 * `POST /api/tax/calculate` (§18.6) — what tax a given amount and destination
 * would attract on this store.
 *
 * A **preview**, not a charge: it writes nothing and creates no obligation. It
 * exists so a merchant can confirm their rates behave as they expect before a
 * shopper is the one who finds out. Checkout does its own calculation from the
 * cart — this endpoint is never the source of a number anyone is billed.
 */
const schema = z.object({
  siteId: z.number().int().positive(),
  amountMinor: z.number().int().min(0),
  address: z
    .object({
      line1: z.string().max(200).optional(),
      city: z.string().max(120).optional(),
      province: z.string().max(120).nullish(),
      postalCode: z.string().max(40).nullish(),
      country: z.string().length(2).regex(/^[A-Za-z]{2}$/),
    })
    .nullish(),
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

    const result = await calculateTax({
      siteId: input.siteId,
      address: input.address
        ? {
            ...input.address,
            line1: input.address.line1 ?? "",
            city: input.address.city ?? "",
            country: input.address.country.toUpperCase(),
          }
        : null,
      taxableBaseMinor: input.amountMinor,
    });

    return NextResponse.json({
      ...result,
      taxableBaseMinor: input.amountMinor,
      /**
       * What the shopper would actually pay. With tax-inclusive pricing the tax
       * is already inside `amountMinor`, so the total does not move — reporting
       * it separately is the only way that stays legible.
       */
      totalMinor: result.included ? input.amountMinor : input.amountMinor + result.amountMinor,
      preview: true,
    });
  },
  { permission: "commerce.read" },
);
