import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireOperator } from "@/lib/auth/operator";
import { platformOverview } from "@/lib/platform/orgs";

/** `GET /api/admin/overview` — the admin dashboard's numbers (G12, §26). Operator-only. */
export const GET = handler(async () => {
  await requireOperator();
  return NextResponse.json(await platformOverview());
});
