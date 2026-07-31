import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { forbidden, handler, unauthorized } from "@/lib/api";
import {
  ACTIVE_ORG_COOKIE,
  getAuthUser,
  listMemberships,
} from "@/lib/auth/session";

/**
 * `POST /api/org/switch` — change the active organization (§16: "the session
 * carries an active org, switchable, and every request derives scope from it").
 *
 * Agencies build stores for clients, so one person legitimately belongs to
 * several orgs. Switching rewrites a preference cookie; it grants nothing on its
 * own, because every request re-resolves membership server-side.
 */
const bodySchema = z.object({ orgId: z.string().min(1).max(64) });

export const POST = handler(async (req) => {
  const user = await getAuthUser();
  if (!user) throw unauthorized();

  const { orgId } = bodySchema.parse(await req.json());

  // Membership is re-checked here rather than trusted from the cookie. This is
  // the check that makes the cookie safe to be non-httpOnly: pointing it at an
  // org you do not belong to simply fails.
  const memberships = await listMemberships(user.id);
  const target = memberships.find((m) => m.org.id === orgId);
  if (!target) throw forbidden("You are not a member of that organization");

  const store = await cookies();
  store.set(ACTIVE_ORG_COOKIE, orgId, {
    // Deliberately not httpOnly: this is a preference, not a credential, and the
    // dashboard reads it to highlight the current org.
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.json({ orgId, name: target.org.name, slug: target.org.slug });
});
