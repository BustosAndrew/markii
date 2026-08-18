import { NextResponse } from "next/server";
import { undoInvocation } from "@/lib/actions";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";

/**
 * `POST /api/actions/:id/undo` — reverse a past invocation (§22).
 *
 * Body: `{ "invocationId": "inv_…" }`. The `:id` in the path is the action the
 * invocation *was*, checked against the record — a caller who has the wrong id
 * is told so rather than quietly undoing something else.
 *
 * **No `permission` here on purpose**, like `actions/[id]` itself: the inverse
 * runs through `invokeAction`, which authorizes it against its own action's
 * permission and re-demands step-up (§22 rule 4). A check here would either
 * duplicate that or, worse, disagree with it. Anywhere else, a mutating handler
 * with no permission is a bug.
 */
export const POST = orgHandler(async (req, { params, session }) => {
  const { id } = await params;

  const raw = await req.text();
  const body = raw ? JSON.parse(raw) : {};
  const invocationId = body?.invocationId;
  if (typeof invocationId !== "string" || !invocationId) {
    throw badRequest("invocationId is required");
  }

  const outcome = await undoInvocation(invocationId, {
    actor: session.actor,
    expectActionId: id,
  });
  return NextResponse.json(outcome);
});
