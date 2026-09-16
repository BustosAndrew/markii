import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireOperator } from "@/lib/auth/operator";
import { platformSignups } from "@/lib/platform/orgs";

/**
 * `GET /api/admin/signups?days=1..30` — the sign-up review as a page: the
 * digest's grouping over a chosen window, plus every recent sign-up
 * (G12, §26). Operator-only.
 */
export const GET = handler(async (req) => {
  await requireOperator();
  const raw = Number(new URL(req.url).searchParams.get("days") ?? 1);
  const days = Number.isFinite(raw) ? Math.min(30, Math.max(1, Math.trunc(raw))) : 1;
  return NextResponse.json(await platformSignups(days));
});
