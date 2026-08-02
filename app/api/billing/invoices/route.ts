import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, feeAssessments } from "@/lib/db";

/**
 * `GET /api/billing/invoices` (§17).
 *
 * **These are fee assessments, not invoices, and the response says so.** An
 * invoice is a demand for payment raised by Stripe Billing, which is not
 * connected. What exists is the closed-period ledger: what each period was
 * assessed at, with the inputs that produced it.
 *
 * Returning them under an `invoices` key with `invoiced: false` on every row
 * would be a smaller lie than inventing invoice numbers, but still a lie — so
 * the key is `assessments` and the state is explicit. When Stripe lands, an
 * invoice references these rows rather than replacing them.
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

    return NextResponse.json({
      assessments: rows.map((r) => ({
        id: r.id,
        periodStart: r.periodStart.toISOString(),
        periodEnd: r.periodEnd.toISOString(),
        planId: r.planId,
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
      invoices: [],
      invoicesState: {
        code: "configuration_required" as const,
        message: "No invoices exist — Stripe Billing is not connected, so nothing has been billed.",
        resolution:
          "Set STRIPE_SECRET_KEY and configure Stripe Billing (docs/API.md §17). The assessments " +
          "above are what each closed period measured; an invoice will cite them.",
      },
    });
  },
  { permission: "billing.read" },
);
