import { NextResponse } from "next/server";
import { invokeAction } from "@/lib/actions";
import { handler } from "@/lib/api";
import { operatorActorFor, requireOperator } from "@/lib/auth/operator";
import { platformOrgView } from "@/lib/platform/orgs";

/**
 * `POST /api/admin/orgs/:idOrSlug/suspend { reason }` and
 * `DELETE /api/admin/orgs/:idOrSlug/suspend` (G12).
 *
 * Both delegate to the registry — `platform.suspendOrg` /
 * `platform.unsuspendOrg` — with an `operator` actor whose `orgId` is the
 * **target** org. That is what makes the write land in the merchant's own
 * audit log as "Markii operator", and what puts step-up, dry-run and the
 * refusal audit in front of it without this route doing any of that itself.
 *
 * `?dryRun=1` works as everywhere else: the diff without the write, so an
 * operator can see which org they are about to take offline before doing it.
 */
async function target(req: Request, params: Promise<Record<string, string>>) {
  const op = await requireOperator();
  const { id } = await params;
  const org = await platformOrgView(id);
  return { actor: operatorActorFor(op, org.id, req), dryRun: new URL(req.url).searchParams.get("dryRun") === "1" };
}

export const POST = handler(async (req, { params }) => {
  const { actor, dryRun } = await target(req, params);
  const raw = await req.text();
  const input = raw ? JSON.parse(raw) : {};
  const outcome = await invokeAction("platform.suspendOrg", input, { actor, dryRun });
  return NextResponse.json(outcome);
});

export const DELETE = handler(async (req, { params }) => {
  const { actor, dryRun } = await target(req, params);
  const outcome = await invokeAction("platform.unsuspendOrg", {}, { actor, dryRun });
  return NextResponse.json(outcome);
});
