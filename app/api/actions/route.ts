import { NextResponse } from "next/server";
import { allActions, describeAction } from "@/lib/actions";
import { orgHandler } from "@/lib/auth/handler";
import { roleHasPermission } from "@/lib/auth/permissions";

/**
 * `GET /api/actions` — the registry: id, description, JSON Schema, permission,
 * risk tier (§22).
 *
 * **Filtered to what the caller may actually invoke.** An agent listing tools it
 * will be refused is a worse experience than not seeing them, and the filter is
 * the same permission check the invocation itself runs.
 */
export const GET = orgHandler(async (_req, { session }) => {
  const items = allActions()
    .filter((a) => roleHasPermission(session.role, a.permission))
    .map(describeAction);

  return NextResponse.json({ items, total: items.length });
});
