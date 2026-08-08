import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { unauthorized } from "../api";
import type { Actor } from "../actions/types";
import {
  apiTokens,
  db,
  organizations,
  staff,
  type Organization,
  type Staff,
  type StaffRole,
} from "../db";
import { getSupabaseServerClient } from "../supabase/server";
import { bearerFrom, hashesMatch, hashToken } from "./tokens";
import { assertMfaSatisfied } from "./mfa";
import { isStaffUser } from "./user-kind";

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

  /**
   * D32 mitigation 3. Staff and shoppers share one Supabase project, so a
   * shopper's session is a structurally valid Supabase session for this origin.
   * This is the explicit refusal — checked from `app_metadata`, which only the
   * service role can write.
   */
  if (!isStaffUser(user)) return null;

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

  /**
   * **MFA is enforced here, not in the wrappers** (D40).
   *
   * `requireSession` and `requireAuthContext` are both real entry points —
   * `/api/me` uses the first, every `orgHandler` route the second — so a check
   * placed in one of them protects exactly half the surface. That is not
   * hypothetical: the first version of this guarded only `requireAuthContext`,
   * and `/api/me` happily served an unenrolled merchant until the tests said so.
   *
   * **It throws rather than returning null**, which is the one thing this
   * function otherwise never does. Null means "not signed in" and produces a
   * 401; this caller *is* signed in, and a 401 would send them back to a form
   * that signs them in successfully and returns them here forever.
   */
  await assertMfaSatisfied();

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

/**
 * What a route actually needs to know about its caller, whether that is a
 * signed-in human, an agent acting for one, or a scoped API/MCP token.
 *
 * §22 rule 4: identical permissions for all three. Routes read `role` and
 * `storeIds` from here and cannot tell — or act on — which kind of caller it is.
 */
export type AuthContext = {
  org: Organization;
  role: StaffRole;
  storeIds: number[] | "all";
  /** Null for token callers — a token is not a person. */
  user: Session["user"] | null;
  staff: Staff | null;
  token: { id: string; label: string } | null;
  /** Ready to hand to `invokeAction` (§22). */
  actor: Actor;
};

function contextFromSession(session: Session): AuthContext {
  return {
    org: session.org,
    role: session.role,
    storeIds: session.staff.storeIds,
    user: session.user,
    staff: session.staff,
    token: null,
    actor: { type: "user", id: session.user.id, orgId: session.org.id },
  };
}

/**
 * Bearer token → context. Tokens are checked before cookies because a request
 * carrying an explicit `Authorization` header is asking to be treated as that
 * token, and silently preferring an ambient cookie would be surprising.
 */
async function contextFromToken(req: Request): Promise<AuthContext | null> {
  const plaintext = bearerFrom(req);
  if (!plaintext) return null;

  const [row] = await db
    .select({ token: apiTokens, org: organizations })
    .from(apiTokens)
    .innerJoin(organizations, eq(organizations.id, apiTokens.orgId))
    .where(and(eq(apiTokens.tokenHash, hashToken(plaintext)), isNull(apiTokens.revokedAt)))
    .limit(1);
  if (!row) return null;

  // Defence in depth: the lookup above already matched on the indexed hash, but
  // comparing in constant time keeps the code honest if that ever becomes a
  // scan rather than an index probe.
  if (!hashesMatch(row.token.tokenHash, hashToken(plaintext))) return null;

  // Best-effort last-used stamp. A failure here must not fail the request — it
  // is telemetry, not authorization.
  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.token.id))
    .catch((e) => console.error("[auth] token lastUsedAt update failed", e));

  return {
    org: row.org,
    role: row.token.role,
    storeIds: row.token.storeIds,
    user: null,
    staff: null,
    token: { id: row.token.id, label: row.token.label },
    actor: { type: "token", id: row.token.id, orgId: row.org.id },
  };
}

/**
 * Resolves a token or a cookie session, or throws.
 *
 * **MFA is enforced on the session path only** (D40). An API token is its own
 * credential, minted by a session that had already satisfied MFA, and refusing
 * it here would break every server-to-server integration without protecting
 * anything its holder could not already reach. A stolen *browser* session is the
 * threat MFA answers; a stolen token is answered by revoking it.
 *
 * The enforcement itself lives inside `getSession`, which is the only function
 * both entry points share — so checking it here as well would be duplication
 * that can drift, and checking it *only* here would leave `/api/me` open.
 * Tokens skip it because they never reach `getSession`.
 */
export async function requireAuthContext(req: Request): Promise<AuthContext> {
  const viaToken = await contextFromToken(req);
  if (viaToken) return viaToken;

  const session = await getSession();
  if (!session) throw unauthorized();
  return contextFromSession(session);
}
