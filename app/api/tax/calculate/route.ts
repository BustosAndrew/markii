import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { calculateTax } from "@/lib/commerce/tax";
import { db, products, sites } from "@/lib/db";
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
  /**
   * Quoted separately because whether delivery is taxable is a jurisdiction's
   * decision, not a rate. The manual path folds it into one base; Stripe Tax
   * asks per destination, and a preview that could not include postage would
   * not match the checkout it is meant to predict.
   */
  shippingMinor: z.number().int().min(0).default(0),
  /** Stripe product tax code to preview against. Falls back to the store default. */
  taxCode: z.string().max(60).nullish(),
  /**
   * ISO 4217. Currency lives on products rather than stores (one currency per
   * store, G2), so a preview with no basket has to be told or read one — this
   * defaults to what the store's catalog actually sells in.
   */
  currency: z.string().length(3).nullish(),
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

    /**
     * Read from the catalog rather than assumed. `USD` as a silent default would
     * preview a UK store's VAT against dollars — the right rate on the wrong
     * money, which is exactly the kind of plausible-looking wrong number a
     * preview exists to prevent.
     */
    const [firstProduct] = await db
      .select({ currency: products.currency })
      .from(products)
      .where(eq(products.siteId, input.siteId))
      .limit(1);
    const currency = input.currency?.toUpperCase() ?? firstProduct?.currency ?? "USD";

    const result = await calculateTax({
      siteId: input.siteId,
      /**
       * **No cart, so nothing is cached and nothing is recorded.** A preview
       * calculation must never become the source of a merchant's Stripe Tax
       * transaction — that belongs to a sale — and reusing one across previews
       * would answer a later question with an earlier basket's tax.
       */
      cartId: null,
      address: input.address
        ? {
            ...input.address,
            line1: input.address.line1 ?? "",
            city: input.address.city ?? "",
            country: input.address.country.toUpperCase(),
          }
        : null,
      taxableBaseMinor: input.amountMinor + input.shippingMinor,
      /**
       * One synthetic line carrying the whole amount. The merchant is asking
       * "what would this cost in tax there", not pricing a basket, so inventing
       * a line breakdown they did not supply would preview a different question
       * than the one they asked.
       */
      lines: [
        {
          reference: "preview",
          amountMinor: input.amountMinor,
          quantity: 1,
          taxCode: input.taxCode ?? null,
        },
      ],
      shippingMinor: input.shippingMinor,
      currency,
    });

    return NextResponse.json({
      amountMinor: result.amountMinor,
      state: result.state,
      included: result.included,
      breakdown: result.breakdown ?? [],
      note: result.note,
      /**
       * `calculationId` is deliberately not here. A preview must never become
       * the source of a tax transaction on the merchant's filings — that belongs
       * to a sale — and a caller holding the id is a caller that could try.
       */
      taxableBaseMinor: input.amountMinor + input.shippingMinor,
      /**
       * What the shopper would actually pay. With tax-inclusive pricing the tax
       * is already inside `amountMinor`, so the total does not move — reporting
       * it separately is the only way that stays legible.
       */
      totalMinor: result.included
        ? input.amountMinor + input.shippingMinor
        : input.amountMinor + input.shippingMinor + result.amountMinor,
      currency,
      preview: true,
    });
  },
  { permission: "commerce.read" },
);
