import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { listBlocklist } from "@/lib/forms/queries";
import { resolveSite } from "@/lib/queries";

/** `GET /api/sites/:idOrSlug/form-blocklist` — senders this store refuses. `commerce.read`; writes are `forms.blockSender` / `unblockSender`. */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    return NextResponse.json({ siteId: site.id, items: await listBlocklist(site.id) }, { headers: { "cache-control": "no-store" } });
  },
  { permission: "commerce.read" },
);
