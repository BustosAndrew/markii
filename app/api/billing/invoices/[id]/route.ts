import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { billingConfigured, retrieveInvoice } from "@/lib/billing/stripe-billing";
import { db, feeAssessments, organizations } from "@/lib/db";

/**
 * `GET /api/billing/invoices/:id` (§17) — one invoice, line-itemized.
 *
 * **The invoice id is caller-supplied, and that is the whole security story
 * here.** `in_…` identifiers live in one namespace shared by every Markii
 * merchant, and the platform key is authorised to read all of them — so a naive
 * fetch-and-return would let any signed-in merchant read any other merchant's
 * invoice by guessing or replaying an id: their legal name, address, spend, and
 * plan. `retrieveInvoice` checks the invoice's customer against *this org's*
 * stored customer id and reports a mismatch as **not found**, because
 * "forbidden" would confirm the invoice exists.
 *
 * The org comes from the session, never from the path — §16's rule applied to a
 * foreign identifier space.
 *
 * **Threshold-fee lines are joined back to their assessments.** A merchant
 * looking at a fee line should be able to reach the arithmetic that produced it
 * without hunting through a separate ledger screen, so any line carrying a
 * `markii_assessment_id` gets its assessment's `workings` attached.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { id } = await params;
    if (!id.startsWith("in_")) {
      // Cheap shape check. It refuses obvious nonsense without a Stripe round
      // trip, and never reveals whether a well-formed id exists.
      throw badRequest("Not an invoice id");
    }

    if (!billingConfigured()) {
      return NextResponse.json(
        {
          error: {
            code: "CONFIGURATION_REQUIRED",
            message: "Stripe Billing is not connected, so no invoice exists.",
            details: { resolution: "Set STRIPE_SECRET_KEY (docs/API.md §17)." },
          },
        },
        { status: 503 },
      );
    }

    const [org] = await db
      .select({ customerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw notFound("Organization");
    /**
     * No customer means this org has never been billed, so no invoice can be
     * theirs. Answering *not found* here rather than falling through keeps one
     * answer for "not yours" and "does not exist".
     */
    if (!org.customerId) throw notFound("Invoice");

    const res = await retrieveInvoice(org.customerId, id);
    if (!res.ok) {
      if (res.status === 404) throw notFound("Invoice");
      return NextResponse.json(
        { error: { code: "UPSTREAM_ERROR", message: res.message } },
        { status: 502 },
      );
    }

    /**
     * Fetched in one query, scoped to the org again on the way out rather than
     * trusted from the invoice's own metadata — the metadata is a string Stripe
     * stored for us, and it is not a tenancy boundary.
     */
    const assessmentIds = res.invoice.lines
      .map((l) => l.assessmentId)
      .filter((v): v is string => Boolean(v));

    const assessments = assessmentIds.length
      ? await db
          .select()
          .from(feeAssessments)
          .where(
            and(eq(feeAssessments.orgId, orgId), inArray(feeAssessments.id, assessmentIds)),
          )
      : [];

    const byId = new Map(assessments.map((a) => [a.id, a]));

    return NextResponse.json({
      ...res.invoice,
      lines: res.invoice.lines.map((line) => {
        const a = line.assessmentId ? byId.get(line.assessmentId) : undefined;
        return {
          ...line,
          /**
           * Present only on a threshold-fee line, and only when the assessment
           * really belongs to this org. "Why this number", answerable from the
           * invoice itself.
           */
          feeAssessment: a
            ? {
                id: a.id,
                periodStart: a.periodStart.toISOString(),
                periodEnd: a.periodEnd.toISOString(),
                productClass: a.productClass,
                thresholdMinor: a.thresholdMinor,
                overageRateBps: a.overageRateBps,
                periodNetSalesMinor: a.periodNetSalesMinor,
                billableMinor: a.billableMinor,
                feeMinor: a.feeMinor,
                workings: a.workings,
                recordCount: a.recordCount,
              }
            : null,
        };
      }),
      /**
       * Markii never renders or stores the PDF — it is Stripe-hosted, and
       * proxying it would put a document with a merchant's legal details through
       * our egress for no benefit.
       */
      documentsAreStripeHosted: true,
    });
  },
  { permission: "billing.read" },
);
