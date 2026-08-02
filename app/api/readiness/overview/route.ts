import { NextResponse } from "next/server";
import { intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db } from "@/lib/db";
import { computeReadiness, recordSnapshot } from "@/lib/readiness/compute";

/**
 * `GET /api/readiness/overview` (§9) — the score card.
 *
 * **Rule-based and deterministic — no model inference.** Every point comes from
 * a named rule over the merchant's real catalog, so the score can be explained
 * issue by issue. `docs/PRICING.md` §"Margin check" also makes it a cost
 * constraint: per-product inference on every plan would exceed every other
 * infrastructure line combined.
 *
 * Computing writes today's snapshot, which is what makes `trend` and
 * `/api/readiness/history` possible — a score is a function of the catalog as it
 * was, and yesterday's catalog is gone.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { report } = await computeReadiness(orgId, {
      siteId: intParam(sp, "siteId"),
      productId: intParam(sp, "productId"),
    });

    // Best-effort: a failed snapshot must not fail the read a dashboard is
    // waiting on. The cost is one missing day on a trend line.
    try {
      await recordSnapshot(db, orgId, report);
    } catch (e) {
      console.error("[readiness] snapshot failed", e);
    }

    return NextResponse.json(report);
  },
  { permission: "catalog.read" },
);
