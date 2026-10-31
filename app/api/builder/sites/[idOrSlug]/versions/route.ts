import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { designVersions } from "@/lib/builder/queries";
import { resolveSite } from "@/lib/queries";

/** Published versions, newest first — what `builder.restoreVersion` can copy back into the draft. */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    return NextResponse.json({ items: await designVersions(site.id) });
  },
  { permission: "cms.read" },
);
