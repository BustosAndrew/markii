import { asc, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites } from "@/lib/db";
import { cnameTarget } from "@/lib/domains/records";
import { storefrontUrl } from "@/lib/queries";
import { ownSitesForStaff } from "@/lib/tenancy";

/**
 * `GET /api/settings/domains` (§2) — every storefront's domain, org-wide.
 *
 * Mutations are actions (§22 rule 1) and are per site: `domains.connect`,
 * `domains.verify`, `domains.disconnect`. This is the overview that answers
 * "which of my stores have a domain, and which are stuck".
 *
 * **This route performs no DNS lookups, and that is the whole reason it exists
 * as its own endpoint rather than a loop over `/api/sites/:id/domain`.** That
 * route reads DNS live — correct for one site, and ten resolver round trips on
 * one page load for a merchant with ten stores, each able to time out
 * independently.
 *
 * The consequence is stated rather than hidden: **`pointsToMarkii` is absent
 * here, not false.** It is a live fact and this response has no live facts in
 * it, so returning a stale one would be worse than returning none — a merchant
 * reading "not pointing" on a domain that points fine would go and break working
 * DNS. `checkedAt` is when `domains.verify` last actually looked; the per-site
 * screen is where a fresh answer comes from.
 */
export const GET = orgHandler(
  async (_req, { session, orgId }) => {
    const rows = await db
      .select()
      .from(sites)
      .where(ownSitesForStaff(orgId, session.storeIds))
      /**
       * Pending first, because this is a worklist: a claim awaiting DNS is the
       * only row here anybody has to do something about. Verified next, and
       * stores with no domain last — those are an opportunity, not a task.
       */
      .orderBy(
        sql`case ${sites.domainStatus} when 'pending' then 0 when 'verified' then 1 else 2 end`,
        asc(sites.name),
      );

    const items = rows.map((s) => ({
      siteId: s.id,
      siteName: s.name,
      siteSlug: s.slug,
      /** Verified-only, same as everywhere else — never the unverified claim. */
      storefrontUrl: storefrontUrl(s),
      domain: s.customDomain,
      status: s.domainStatus,
      verifiedAt: s.domainVerifiedAt?.toISOString() ?? null,
      /** Null means never checked, which is different from checked and failing. */
      checkedAt: s.domainCheckedAt?.toISOString() ?? null,
      problem: s.domainLastError,
    }));

    return NextResponse.json({
      items,
      counts: {
        verified: items.filter((i) => i.status === "verified").length,
        pending: items.filter((i) => i.status === "pending").length,
        none: items.filter((i) => i.status === "none").length,
      },
      /** What a merchant points a domain at on this deployment. */
      expectedTarget: cnameTarget(),
      /**
       * Explicit so no screen infers freshness from the absence of a problem.
       * Every field above is what the last explicit check wrote, not what DNS
       * says right now.
       */
      dnsCheckedLive: false,
    });
  },
  { permission: "cms.read" },
);
