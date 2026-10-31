import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { designChecks } from "@/lib/builder/queries";
import { resolveSite } from "@/lib/queries";

/** The pre-publish checks against the current draft — errors block publishing, warnings inform. */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    return NextResponse.json(await designChecks(site.id), { headers: { "cache-control": "no-store" } });
  },
  { permission: "cms.read" },
);
