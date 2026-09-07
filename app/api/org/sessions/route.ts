import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { listUserSessions } from "@/lib/auth/sessions";

/**
 * `GET /api/org/sessions` (§16) — the devices this user is signed in on.
 *
 * **Cookie-only, like `/api/me`**, and for the same reason: it calls
 * `requireSession()` rather than `requireAuthContext`, so an API token gets a
 * `401`. A token has no browser session to list, and the coherent answer to
 * "which of my sessions are live" for a token holder is `GET /api/org/tokens` —
 * a different list with its own revoke.
 *
 * That choice is also why there is no `permission` here to omit. This is not a
 * read of org data gated by a role; it is the caller reading their own sessions,
 * which every role may do and no role may do for anybody else. `orgHandler`'s
 * rule that a handler without a permission is a bug applies to org-scoped
 * routes, and this one is user-scoped — the org appears in the path because
 * that is where §16 pins the URL, not because the org is the subject.
 */
export const GET = handler(async () => {
  const { user } = await requireSession();
  return NextResponse.json({ items: await listUserSessions(user.id) });
});
