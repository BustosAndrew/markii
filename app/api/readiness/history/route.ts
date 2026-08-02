import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, readinessSnapshots } from "@/lib/db";
import { dayKey } from "@/lib/readiness/compute";

/**
 * `GET /api/readiness/history` (§9) — the trend line.
 *
 * Reads stored snapshots and **never backfills**. A score is a function of the
 * catalog as it was, and yesterday's catalog is gone — so a store with three
 * days of history returns three points, not a flat line invented back to its
 * creation date. An empty result is the honest answer for a store that has not
 * been scored yet, and the response says so rather than returning zeros a chart
 * would draw as a crash to nothing.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const scope = (sp.get("scope") ?? "organization") as "organization" | "site" | "product";
    if (!["organization", "site", "product"].includes(scope)) {
      throw badRequest("scope must be organization, site, or product");
    }
    const scopeId = intParam(sp, "scopeId") ?? null;
    if (scope !== "organization" && scopeId == null) {
      throw badRequest(`scope "${scope}" needs a scopeId`);
    }

    const conds = [
      eq(readinessSnapshots.orgId, orgId),
      eq(readinessSnapshots.scope, scope),
      scopeId == null ? isNull(readinessSnapshots.scopeId) : eq(readinessSnapshots.scopeId, scopeId),
    ];
    const from = sp.get("from");
    if (from) conds.push(gte(readinessSnapshots.day, dayKey(new Date(from))));
    const to = sp.get("to");
    if (to) conds.push(lte(readinessSnapshots.day, dayKey(new Date(to))));

    const rows = await db
      .select()
      .from(readinessSnapshots)
      .where(and(...conds))
      .orderBy(asc(readinessSnapshots.day))
      .limit(400);

    return NextResponse.json({
      points: rows.map((r) => ({
        date: r.day,
        score: r.score,
        components: r.components,
        counts: r.counts,
      })),
      /**
       * Snapshots are written when the overview is computed, so history starts
       * the first time someone looked. Saying that is better than a chart that
       * appears to show a store springing into existence last Tuesday.
       */
      note:
        rows.length === 0
          ? "No history yet — scores are recorded from the first time readiness is computed."
          : undefined,
    });
  },
  { permission: "catalog.read" },
);
