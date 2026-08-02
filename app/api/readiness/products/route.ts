import { NextResponse } from "next/server";
import { intParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import {
  COMPLETENESS_GROUPS,
  NOT_MEASURED_GROUPS,
  completenessFor,
  loadProductFacts,
  productScore,
} from "@/lib/readiness/compute";

/**
 * `GET /api/readiness/products` (§9, FR-CM-01) — the completeness matrix.
 *
 * **`columns` lists only groups this platform has fields for.** The §11
 * agent-data extension — use cases, FAQs, machine summaries, compatibility — is
 * Phase E and does not exist, so it appears in `notMeasured` with the reason
 * rather than as a column every merchant scores zero on. Marking someone down
 * for a field Markii does not offer would be a fabricated criticism, and it
 * would make the matrix unreadable at exactly the moment it should be useful.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);

    const facts = await loadProductFacts(orgId, {
      siteId: intParam(sp, "siteId"),
      categoryId: intParam(sp, "categoryId"),
    });

    const q = sp.get("q")?.toLowerCase();
    const filtered = q ? facts.filter((p) => p.name.toLowerCase().includes(q)) : facts;

    const now = new Date();
    const items = filtered.map((p) => {
      const { score, issueCount } = productScore(p, now);
      return {
        productId: p.id,
        name: p.name,
        siteId: p.siteId,
        enabled: p.enabled,
        score,
        issueCount,
        ...completenessFor(p),
      };
    });

    // Worst first: the matrix exists to find what needs work.
    items.sort((a, b) => a.score - b.score || a.productId - b.productId);

    return NextResponse.json({
      columns: COMPLETENESS_GROUPS.map((g) => ({ ...g, fields: [...g.fields] })),
      notMeasured: NOT_MEASURED_GROUPS.map((g) => ({ ...g, fields: [...g.fields] })),
      items: items.slice(offset, offset + limit),
      total: items.length,
      page,
      limit,
    });
  },
  { permission: "catalog.read" },
);
