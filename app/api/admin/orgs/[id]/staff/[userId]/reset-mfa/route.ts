import { NextResponse } from "next/server";
import { invokeAction } from "@/lib/actions";
import { handler } from "@/lib/api";
import { operatorActorFor, requireOperator } from "@/lib/auth/operator";
import { platformOrgView } from "@/lib/platform/orgs";

/**
 * `POST /api/admin/orgs/:idOrSlug/staff/:userId/reset-mfa { verification }`
 * → `platform.resetMfa` (G12, §26). Operator-only; `?dryRun=1` reports how
 * many factors would go without removing any. The actor's `orgId` is the org
 * in the path, so the reset lands in *that* org's audit log.
 */
export const POST = handler(async (req, { params }) => {
  const op = await requireOperator();
  const { id, userId } = await params;
  const org = await platformOrgView(id);
  const raw = await req.text();
  const body = raw ? JSON.parse(raw) : {};
  const outcome = await invokeAction(
    "platform.resetMfa",
    { ...body, userId },
    {
      actor: operatorActorFor(op, org.id, req),
      dryRun: new URL(req.url).searchParams.get("dryRun") === "1",
    },
  );
  return NextResponse.json(outcome);
});
