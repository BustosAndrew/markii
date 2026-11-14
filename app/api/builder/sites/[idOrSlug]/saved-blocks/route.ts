import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { savedBlocks } from "@/lib/builder/queries";
import { resolveSite } from "@/lib/queries";

/**
 * The site's saved blocks (M7), by name. Each `node` is ready for
 * `builder.insertNodes`; saving and deleting are `builder.saveBlock` and
 * `builder.deleteSavedBlock`.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    return NextResponse.json({ items: await savedBlocks(site.id) });
  },
  { permission: "cms.read" },
);
