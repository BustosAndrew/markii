import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { planCatalog } from "@/lib/plans";

/**
 * `GET /api/billing/plans` (§17) — the public plan catalog.
 *
 * Public on purpose: a pricing page needs it before anyone has an account.
 *
 * **Prices are marked PROPOSED.** `docs/PRICING.md` §3 states them as proposals
 * that have not been signed off, and shipping them as settled would be a
 * commitment nobody made. The flag travels with the data so no surface can
 * quietly drop it.
 *
 * **No competitor comparisons are returned.** §17 allows them only as data with
 * a `verifiedAt`, sourced from `docs/COMPETITORS.md` (verified 2026-07-29,
 * re-check quarterly) — never from memory. Wiring that up means reading the file
 * at build time, and a comparison whose provenance is a hand-typed constant is
 * exactly what the claim-discipline rule forbids. Until it is sourced properly,
 * returning nothing is the honest answer.
 */
export const GET = handler(async () => {
  return NextResponse.json({
    currency: "USD",
    items: planCatalog().map((p) => ({
      ...p,
      /** Both figures are per month; `annualPerMonthMinor` applies when billed yearly. */
      billing: { monthly: p.monthlyPriceMinor, annualPerMonth: p.annualPerMonthMinor },
    })),
    status: "proposed" as const,
    note:
      "Prices are proposed and not yet finalised. Markii charges no transaction fee below the " +
      "plan threshold, on any payment provider, including digital goods.",
    comparisons: [],
    comparisonsNote:
      "Competitor comparisons are omitted rather than hardcoded. They are factual claims and must " +
      "carry a verification date from Markii’s competitor research.",
  });
});
