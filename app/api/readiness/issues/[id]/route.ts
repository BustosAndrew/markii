import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { computeReadiness } from "@/lib/readiness/compute";

/**
 * `GET /api/readiness/issues/:id` (§9) — the drawer payload.
 *
 * Found by recomputing and matching the id rather than by a table lookup,
 * because there is no issue table (see the list route). The id is deterministic,
 * so this is stable across requests — and an id that no longer matches anything
 * means the underlying problem was **fixed**, which is a 404 with a real
 * meaning rather than a missing row.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { id } = await params;
    const { issues } = await computeReadiness(orgId);
    const issue = issues.find((i) => i.id === id);
    if (!issue) {
      return NextResponse.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "That issue is not currently present.",
            details: {
              // Worth saying: the usual reason is the good one.
              note:
                "Readiness issues are recomputed from your catalog. An issue that no longer " +
                "appears has most likely been fixed.",
            },
          },
        },
        { status: 404 },
      );
    }
    return NextResponse.json(issue);
  },
  { permission: "catalog.read" },
);
