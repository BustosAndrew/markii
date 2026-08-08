import "server-only";

/**
 * Turning a closed threshold-fee assessment into money actually owed (§17,
 * `docs/PRICING.md` §4).
 *
 * **This is the line between a measurement and a bill**, and everything about
 * the module is arranged so that crossing it is deliberate. `fee_assessments`
 * has always been a record of what a period *measured*; nothing charged it, and
 * every surface said so. This is what changes that, one assessment at a time,
 * with the merchant's own invoice as the destination.
 *
 * **It creates invoice *items*, never invoices.** A pending invoice item is
 * pulled onto the customer's next subscription invoice automatically, which is
 * exactly what `docs/PRICING.md` promises — the threshold fee appears as a named
 * line on the Markii invoice the merchant already gets, alongside the plan.
 * Drawing a separate invoice per period would bill the same merchant twice a
 * month for one relationship, and would need its own dunning.
 *
 * That choice has a consequence worth stating: **an item created for a customer
 * with no active subscription is never invoiced.** It sits pending forever. So
 * the caller must refuse in that case rather than create one — see
 * `assessmentBillable`.
 */

const API = "https://api.stripe.com/v1";
const API_VERSION = "2025-03-31.basil";

export type FeeInvoiceFailure = {
  ok: false;
  code: "configuration_required" | "unavailable" | "refused";
  message: string;
  resolution?: string;
};

/** The subset of a `fee_assessments` row this needs. Passed in, never re-queried. */
export type BillableAssessment = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  planId: string;
  productClass: "physical" | "digital" | null;
  currency: string;
  feeMinor: number;
  billableMinor: number;
  thresholdMinor: number;
  overageRateBps: number;
  invoiced: boolean;
};

/**
 * Whether an assessment may be turned into a charge at all.
 *
 * Every one of these is a refusal rather than a skip, because the caller is
 * asking to bill a merchant and a silent no-op there is indistinguishable from
 * a success — the assessment would stay `invoiced: false` and be retried
 * forever, or worse, be marked billed with nothing behind it.
 */
export function assessmentBillable(
  assessment: BillableAssessment,
  context: { customerId: string | null; subscriptionActive: boolean; billingCurrency: string },
): { ok: true } | FeeInvoiceFailure {
  if (assessment.invoiced) {
    return {
      ok: false,
      code: "refused",
      message: `Assessment ${assessment.id} is already invoiced.`,
      resolution: "A closed period bills once. Nothing to do.",
    };
  }
  if (assessment.feeMinor <= 0) {
    /**
     * Not an error, but still not billable. A merchant under their threshold
     * owes nothing, and a zero-amount line on their invoice would invite the
     * question of what it is for. The caller marks it settled without an item.
     */
    return {
      ok: false,
      code: "refused",
      message: `Assessment ${assessment.id} is for ${assessment.feeMinor} — nothing is owed.`,
      resolution: "Mark it settled with no invoice item; there is no charge to raise.",
    };
  }
  if (!context.customerId) {
    return {
      ok: false,
      code: "refused",
      message: "This organization has no Stripe customer, so there is no invoice to add a line to.",
      resolution: "Start a subscription first (billing.changePlan).",
    };
  }
  if (!context.subscriptionActive) {
    /**
     * **The trap this module is shaped around.** A pending invoice item needs a
     * subscription invoice to ride on. Created without one it is never billed,
     * never expires, and silently attaches to whatever invoice appears months
     * later — charging a merchant for a period they may not even remember.
     */
    return {
      ok: false,
      code: "refused",
      message: "No active subscription, so a pending invoice item would never be billed.",
      resolution:
        "Threshold fees ride on the merchant's Markii subscription invoice. Without one there " +
        "is nothing to attach to — start a subscription, or bill this period by hand.",
    };
  }
  if (assessment.currency.toUpperCase() !== context.billingCurrency.toUpperCase()) {
    /**
     * Stripe will not pull an item onto an invoice in a different currency, and
     * converting here would invent an FX rate — the same refusal the meter makes
     * for unconverted usage records rather than summing them as zero.
     */
    return {
      ok: false,
      code: "refused",
      message:
        `Assessment is in ${assessment.currency} but the customer bills in ` +
        `${context.billingCurrency}; Stripe cannot combine them.`,
      resolution: "No FX provider is wired. Bill this period by hand rather than inventing a rate.",
    };
  }
  return { ok: true };
}

/**
 * A line a merchant can check against their own numbers.
 *
 * `workings` on the assessment row exists so "why this number" has an exact
 * answer; this puts the short version where they will actually read it, on the
 * invoice itself. The rate is rendered from basis points rather than hardcoded
 * as a percentage string, and the amounts are left in minor units for the
 * caller's formatter — nothing here divides by 100 (D31).
 */
export function feeLineDescription(a: BillableAssessment, format: (minor: number) => string): string {
  const period = `${a.periodStart.toISOString().slice(0, 10)} – ${a.periodEnd.toISOString().slice(0, 10)}`;
  const rate = `${(a.overageRateBps / 100).toFixed(2)}%`;
  const scope = a.productClass ? `${a.productClass} sales` : "sales";
  return (
    `Markii threshold fee — ${scope}, ${period}. ` +
    `${format(a.billableMinor)} above the ${format(a.thresholdMinor)} ${a.planId} threshold at ${rate}.`
  );
}

/**
 * Adds the fee to the customer's next invoice.
 *
 * **Idempotent on the assessment id.** Stripe collapses a retry carrying the
 * same key onto the first item rather than creating a second, which matters
 * because the caller writes `invoiced = true` in a transaction that can roll
 * back after this call has already succeeded. Without the key, the retry bills
 * the merchant twice for one period — the exact dispute `docs/BACKEND.md` warns
 * idempotency keys exist to prevent.
 */
export async function createFeeInvoiceItem(input: {
  customerId: string;
  assessment: BillableAssessment;
  description: string;
}): Promise<{ ok: true; invoiceItemId: string } | FeeInvoiceFailure> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return {
      ok: false,
      code: "configuration_required",
      message: "Stripe Billing is not connected.",
      resolution: "Set STRIPE_SECRET_KEY (docs/API.md §17).",
    };
  }

  const body = new URLSearchParams({
    customer: input.customerId,
    /**
     * Passed through unscaled — Stripe expects the currency's smallest unit,
     * which is what `feeMinor` already is. A `/100` here would overcharge a JPY
     * merchant a hundredfold (D31).
     */
    amount: String(input.assessment.feeMinor),
    currency: input.assessment.currency.toLowerCase(),
    description: input.description,
    "metadata[markii_assessment_id]": input.assessment.id,
    "metadata[markii_period_start]": input.assessment.periodStart.toISOString(),
    "metadata[markii_product_class]": input.assessment.productClass ?? "unclassified",
  });

  let res: Response;
  try {
    res = await fetch(`${API}/invoiceitems`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${secret}`,
        "Stripe-Version": API_VERSION,
        "Idempotency-Key": `markii_fee_${input.assessment.id}`,
      },
      body: body.toString(),
    });
  } catch (e) {
    return {
      ok: false,
      code: "unavailable",
      message: e instanceof Error ? e.message : "Could not reach Stripe.",
    };
  }

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.id) {
    return {
      ok: false,
      code: "unavailable",
      message: json.error?.message ?? `Stripe returned ${res.status}.`,
    };
  }
  return { ok: true, invoiceItemId: json.id };
}
