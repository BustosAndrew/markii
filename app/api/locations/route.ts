import { NextResponse } from "next/server";
import { intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { locationsForOrg } from "@/lib/commerce/queries";

/**
 * `GET /api/locations` — inventory locations (§18.1).
 *
 * Creation goes through the `inventory.createLocation` action, not a `POST`
 * here: every mutation runs through the registry so the UI, agents, and MCP all
 * take the same path (§22 rule 1).
 */
export const GET = orgHandler(async (req, { orgId }) => {
  const sp = new URL(req.url).searchParams;
  const items = await locationsForOrg(orgId, intParam(sp, "siteId") ?? undefined);
  return NextResponse.json({ items });
});
