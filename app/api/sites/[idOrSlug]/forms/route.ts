import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { listForms } from "@/lib/forms/queries";
import { resolveSite } from "@/lib/queries";

/** `GET /api/sites/:idOrSlug/forms` — the store's forms with their submission counts. Writes are `forms.*` actions. */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    return NextResponse.json({ siteId: site.id, items: await listForms(site.id) }, { headers: { "cache-control": "no-store" } });
  },
  { permission: "cms.read" },
);
