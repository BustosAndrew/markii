import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { usageMeterFor } from "@/lib/billing/meter";

/**
 * `GET /api/billing/usage` (§17) — the threshold meter.
 *
 * Computed from the **immutable usage ledger**, never a live join over orders
 * (`docs/PRICING.md` §4.5): orders mutate, and a fee recomputed from them would
 * change after it was invoiced.
 *
 * Three contract rules this route exists to keep:
 *
 * - `billableThisPeriodMinor` is **marginal** — only the slice of this period's
 *   sales above the threshold, never the whole period and never retroactively.
 * - Projections are labeled as projections. `projectionBasis` travels with the
 *   number so nothing can render it as an amount owed.
 * - Before a first production sale everything is `null` with
 *   `dataSource: "not_yet_measured"`, never `0` — a zero is a measurement, and
 *   there has not been one.
 */
export const GET = orgHandler(
  async (_req, { orgId }) => {
    return NextResponse.json(await usageMeterFor(orgId));
  },
  { permission: "billing.read" },
);
