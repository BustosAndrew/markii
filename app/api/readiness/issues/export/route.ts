import { intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { computeReadiness } from "@/lib/readiness/compute";

/**
 * `GET /api/readiness/issues/export` (§9) — the same list as CSV.
 *
 * Same filters as the table, so an export matches what the merchant was looking
 * at. A merchant working through a backlog wants it in a spreadsheet, and a CSV
 * that quietly differs from the screen is worse than none.
 */

/** RFC 4180: quote everything, double any embedded quote. Recommendations contain commas. */
function cell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { issues } = await computeReadiness(orgId, {
      siteId: intParam(sp, "siteId"),
      productId: intParam(sp, "productId"),
      categoryId: intParam(sp, "categoryId"),
      component: sp.get("component") ?? undefined,
      severity: sp.get("severity") ?? undefined,
      status: sp.get("status") ?? undefined,
      q: sp.get("q") ?? undefined,
    });

    const header = [
      "id",
      "severity",
      "component",
      "code",
      "title",
      "status",
      "siteId",
      "productId",
      "affectedFields",
      "recommendation",
      "expectedImpact",
      "assignedTo",
    ];

    const rows = issues.map((i) =>
      [
        i.id,
        i.severity,
        i.component,
        i.code,
        i.title,
        i.status,
        i.scope.siteId,
        i.scope.productId,
        i.affectedFields.join(" "),
        i.recommendation,
        i.expectedImpact,
        i.assignedTo,
      ]
        .map(cell)
        .join(","),
    );

    return new Response([header.map(cell).join(","), ...rows].join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="readiness-issues-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  },
  { permission: "catalog.read" },
);
