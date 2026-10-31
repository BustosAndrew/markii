import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { designRow, leaseView } from "@/lib/builder/queries";
import { resolveSite } from "@/lib/queries";

/**
 * The draft's revision and the agent's edit lease — what the editor polls to
 * reload the live preview and to know whether the agent holds the pen. Kept
 * to one indexed read because it is asked every couple of seconds.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const design = await designRow(site.id);
    return NextResponse.json(
      design
        ? { started: true, revision: design.draftRevision, publishedRevision: design.publishedRevision, agentLock: leaseView(design) }
        : { started: false, revision: 0, publishedRevision: 0, agentLock: { active: false, sessionId: null, expiresAt: null } },
      { headers: { "cache-control": "no-store" } },
    );
  },
  { permission: "cms.read" },
);
