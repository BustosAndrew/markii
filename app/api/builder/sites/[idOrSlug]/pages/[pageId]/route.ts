import { NextResponse } from "next/server";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { pageDocument } from "@/lib/builder/queries";
import { resolveSite } from "@/lib/queries";

/** One page: its draft tree and, once published, what is live. */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug, pageId } = await params;
    if (!/^\d+$/.test(pageId)) throw badRequest("pageId must be a number");
    const site = await resolveSite(idOrSlug, orgId);
    return NextResponse.json(await pageDocument(site.id, Number(pageId)), {
      headers: { "cache-control": "no-store" },
    });
  },
  { permission: "cms.read" },
);
