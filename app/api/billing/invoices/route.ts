import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { billingConfigured, listInvoices } from "@/lib/billing/stripe-billing";
import { db, feeAssessments, organizations } from "@/lib/db";

/**
 * `GET /api/billing/invoices` (§17).
 *
 * **Two different things, kept apart because they mean different things.**
 *
 * `invoices` are Stripe's — real demands for payment, with real numbers and a
 * hosted PDF. They cover the **subscription**.
 *
 * `assessments` are the closed-period threshold-fee ledger: what each period
 * *measured*, with the inputs that produced it. They are **not invoices**, and
 * `fee_assessments.invoiced` is still `false` on every row — threshold-fee
 * invoicing is not built (`docs/PRICING.md` §4). Merging them into one list
 * under an `invoices` key would claim money had been demanded that has not been.
 *
 * When threshold-fee billing lands, an invoice will *cite* these rows rather
 * than replace them, and `invoiced` becomes the link.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);

    const rows = await db
      .select()
      .from(feeAssessments)
      .where(eq(feeAssessments.orgId, orgId))
      .orderBy(desc(feeAssessments.periodStart))
      .limit(limit)
      .offset(offset);

    const [org] = await db
      .select({ customerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const invoices = await fetchInvoices(org?.customerId ?? null, limit);

    return NextResponse.json({
      assessments: rows.map((r) => ({
        id: r.id,
        periodStart: r.periodStart.toISOString(),
        periodEnd: r.periodEnd.toISOString(),
        planId: r.planId,
        productClass: r.productClass,
        currency: r.currency,
        thresholdMinor: r.thresholdMinor,
        overageRateBps: r.overageRateBps,
        t12NetSalesMinor: r.t12NetSalesMinor,
        periodNetSalesMinor: r.periodNetSalesMinor,
        billableMinor: r.billableMinor,
        feeMinor: r.feeMinor,
        /** The formula's own inputs — "why this number" answered from the row. */
        workings: r.workings,
        recordCount: r.recordCount,
        invoiced: r.invoiced,
        closedAt: r.closedAt.toISOString(),
      })),
      total: rows.length,
      page,
      limit,
      invoices: invoices.list,
      invoicesState: invoices.state,
      /**
       * Said plainly next to the assessments, because they carry money-shaped
       * numbers that a screen could easily render as amounts owed.
       */
      assessmentsState: {
        code: "measurement_only" as const,
        message:
          "Threshold fees are measured but not yet invoiced — no assessment below has been billed.",
      },
    });
  },
  { permission: "billing.read" },
);

/** Stripe's invoices, with the three outcomes kept distinct rather than collapsed to an empty list. */
async function fetchInvoices(customerId: string | null, limit: number) {
  if (!billingConfigured()) {
    return {
      list: [],
      state: {
        code: "configuration_required" as const,
        message: "No invoices — Stripe Billing is not connected, so nothing has been billed.",
        resolution: "Set STRIPE_SECRET_KEY (docs/API.md §17).",
      },
    };
  }
  if (!customerId) {
    /**
     * Not an error, and not the same as "no invoices": this org has never
     * subscribed, so Stripe has nothing to return. An empty list with no state
     * would read as "you have been billed nothing", which is true but says
     * nothing about why.
     */
    return {
      list: [],
      state: {
        code: "not_subscribed" as const,
        message: "No subscription has ever been started, so no invoice exists.",
      },
    };
  }

  const res = await listInvoices(customerId, limit);
  if (!res.ok) {
    /**
     * Soft-fail. The assessments above are local and still worth returning; a
     * Stripe outage should not blank the whole billing history.
     */
    return {
      list: [],
      state: { code: "unavailable" as const, message: res.message },
    };
  }
  return { list: res.invoices, state: null };
}
