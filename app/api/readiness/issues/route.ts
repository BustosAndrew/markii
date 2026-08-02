import { NextResponse } from "next/server";
import { intParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { computeReadiness } from "@/lib/readiness/compute";

/**
 * `GET /api/readiness/issues` (§9) — the health table.
 *
 * Issues are **recomputed from the catalog on every request**, not read from a
 * table: a stored issue goes stale the moment someone edits a product, and a
 * merchant who has just added a description should see it disappear, not wait
 * for a job. What persists is only what they *decided* — dismissed, resolved,
 * assigned.
 *
 * `counts` is over the filtered set, so the numbers match the rows on screen.
 * The **score** is deliberately not filtered — see `computeReadiness`.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);

    const { issues, report } = await computeReadiness(orgId, {
      siteId: intParam(sp, "siteId"),
      productId: intParam(sp, "productId"),
      categoryId: intParam(sp, "categoryId"),
      component: sp.get("component") ?? undefined,
      severity: sp.get("severity") ?? undefined,
      status: sp.get("status") ?? undefined,
      q: sp.get("q") ?? undefined,
    });

    const counts = issues.reduce(
      (acc, i) => {
        if (i.status === "open" || i.status === "assigned") acc[i.severity] += 1;
        return acc;
      },
      { critical: 0, warning: 0, opportunity: 0 },
    );

    return NextResponse.json({
      items: issues.slice(offset, offset + limit),
      total: issues.length,
      page,
      limit,
      counts,
      /** The unfiltered score, so a filtered table cannot imply a better store. */
      score: report.score,
    });
  },
  { permission: "catalog.read" },
);
