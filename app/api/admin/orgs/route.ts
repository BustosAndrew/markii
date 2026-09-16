import { NextResponse } from "next/server";
import { handler, pagination } from "@/lib/api";
import { requireOperator } from "@/lib/auth/operator";
import { listPlatformOrgs } from "@/lib/platform/orgs";

/**
 * `GET /api/admin/orgs?q=&suspended=true|false&page=&limit=` — every merchant
 * org, newest first, as a platform operator sees it (G12, §26). Operator-only;
 * see `requireOperator` for why this is not `orgHandler`.
 */
export const GET = handler(async (req) => {
  await requireOperator();
  const sp = new URL(req.url).searchParams;
  const suspendedRaw = sp.get("suspended");
  return NextResponse.json(
    await listPlatformOrgs({
      q: sp.get("q") ?? undefined,
      suspended: suspendedRaw === "true" ? true : suspendedRaw === "false" ? false : undefined,
      ...pagination(sp),
    }),
  );
});
