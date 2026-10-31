import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { designSummary } from "@/lib/builder/queries";
import { resolveSite } from "@/lib/queries";

/**
 * A site's design as the editor opens it: draft theme and tokens, pages,
 * revision, publish state and the agent's edit lease. `started: false` when
 * `builder.startDesign` has never run for the site.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    return NextResponse.json(await designSummary(site.id), { headers: { "cache-control": "no-store" } });
  },
  { permission: "cms.read" },
);
