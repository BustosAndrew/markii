import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { currentSessionId, revokeUserSession } from "@/lib/auth/sessions";

/**
 * `DELETE /api/org/sessions/:id` (§16) — sign one device out.
 *
 * **Revoking the current session is allowed**, and is how "sign out everywhere"
 * is built out of this route: refusing it would make the one session an
 * attacker is most likely to be holding — the one they are using — the only one
 * that cannot be cut off. `wasCurrent` says which it was, so the dashboard can
 * redirect to sign-in rather than re-render an empty list against a dead cookie.
 *
 * **404 for a session that is not the caller's**, never 403. A 403 would confirm
 * the id names a real session belonging to somebody, which is the whole content
 * of the question an attacker would be asking.
 *
 * Not gated on account standing: `/api/org` is exempt because withholding the
 * ability to secure an account over an unpaid invoice turns a billing problem
 * into a security incident the merchant is forbidden to contain.
 */
export const DELETE = handler(async (_req, { params }) => {
  const { id } = await params;
  const { user } = await requireSession();

  /**
   * Asked before the delete, not after: the answer comes from the caller's own
   * access-token claim, and reading it afterwards would be reading it against a
   * session row that no longer exists.
   */
  const wasCurrent = (await currentSessionId()) === id;

  if (!(await revokeUserSession(user.id, id))) throw notFound("Session");

  return NextResponse.json({ deleted: true, id, wasCurrent });
});
