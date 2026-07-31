import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { unauthorized } from "../api";
import { db, organizations, staff, type Organization, type Staff, type StaffRole } from "../db";
import { getSupabaseServerClient } from "../supabase/server";

/**
 * Which org a multi-org user is currently acting in. A user may belong to
 * several orgs (agencies build stores for clients), so scope cannot be derived
 * from identity alone.
 *
 * Not `httpOnly` — it is a preference, not a credential, and it grants nothing:
 * every lookup re-checks staff membership server-side, so pointing it at
 * someone else's org id simply fails to resolve.
 */
export const ACTIVE_ORG_COOKIE = "markii-active-org";

export type Session = {
  user: { id: string; email: string | null; name: string | null };
  org: Organization;
  staff: Staff;
  role: StaffRole;
};

/**
 * The authenticated user, with no org attached.
 *
 * Sign-up's first request and the recovery flow both need identity before any
 * org exists, so this is separate from `getSession`.
 */
export async function getAuthUser(): Promise<{
  id: string;
  email: string | null;
  name: string | null;
} | null> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;

  // `getUser()` revalidates with Supabase. `getSession()` trusts the cookie's
  // own claims, which is exactly what an attacker would want us to do.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  return {
    id: user.id,
    email: user.email ?? null,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  };
}

/** Every org the user is an active member of, oldest first. */
export async function listMemberships(userId: string) {
  return db
    .select({ org: organizations, staff })
    .from(staff)
    .innerJoin(organizations, eq(organizations.id, staff.orgId))
    .where(and(eq(staff.userId, userId), eq(staff.status, "active")))
    .orderBy(asc(organizations.createdAt));
}

/**
 * Resolves the caller's identity **and** their scope in one place, so no route
 * has to assemble it. Returns `null` when unauthenticated or when the user has
 * no active membership — both are "you cannot act here", and distinguishing them
 * to the caller leaks whether an account exists.
 */
export async function getSession(): Promise<Session | null> {
  const user = await getAuthUser();
  if (!user) return null;

  const memberships = await listMemberships(user.id);
  if (memberships.length === 0) return null;

  const requested = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const active =
    memberships.find((m) => m.org.id === requested) ?? memberships[0];

  return {
    user,
    org: active.org,
    staff: active.staff,
    role: active.staff.role,
  };
}

/** `getSession`, but throws the 401 the dashboard treats as "redirect to sign-in". */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw unauthorized();
  return session;
}
