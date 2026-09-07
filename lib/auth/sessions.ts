import "server-only";

import { sql } from "../db";
import { getSupabaseServerClient } from "../supabase/server";

/**
 * Active browser sessions for one user (§16, `/api/org/sessions`).
 *
 * **These are Supabase's rows, not ours.** GoTrue owns `auth.sessions`, so this
 * module reads it and deletes from it rather than keeping a mirror. A mirror
 * would be a second source of truth for whether someone is signed in, and the
 * copy that drifted would be the one the revoke button writes to — a merchant
 * clicking "revoke" on a session that is still very much alive is worse than no
 * button at all.
 *
 * The cost of that choice is a dependency on a schema Markii does not migrate.
 * It is confined to this file for exactly that reason: if a Supabase upgrade
 * moves a column, one module fails rather than the auth path. Nothing in
 * `getSession()` reads these rows, so a break here cannot lock anyone out.
 *
 * **Scoped to the caller, never the org.** `/api/org/staff/:id` already answers
 * offboarding — `listMemberships` filters on `status = 'active'`, so disabling
 * or removing a staff member ends their access on their next request without
 * touching a session row. What this adds is the other question, the one nothing
 * answered: *which devices am I signed in on, and can I cut one off?*
 */

export type ActiveSession = {
  id: string;
  /** Null is a real answer — a client may send no `User-Agent` at all. */
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
};

/**
 * Timestamps arrive as **strings**, already formatted by Postgres — see the
 * query. Typing them `Date` and calling `toISOString()` is the obvious version
 * and it 500s: this connection hands timestamps back as text, so the method
 * does not exist.
 */
type SessionRow = {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_active_at: string;
};

/** Cheap guard before a `::uuid` cast, which raises `22P02` on anything else. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The `session_id` claim on the caller's own access token, used **only** to
 * mark one row `current`.
 *
 * Read from the JWT payload without verifying the signature, which is safe
 * precisely because of what it is allowed to influence: identity was already
 * established by `getAuthUser()` (a real `getUser()` round trip), every query
 * below is filtered on that user's id, and a forged claim could therefore do
 * nothing but mislabel one of the caller's own rows in their own list. It must
 * never become an authorization input.
 */
export async function currentSessionId(): Promise<string | null> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return null;

  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims?.session_id === "string" ? claims.session_id : null;
  } catch {
    return null;
  }
}

function serialize(row: SessionRow, currentId: string | null): ActiveSession {
  return {
    id: row.id,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    current: currentId !== null && row.id === currentId,
  };
}

/**
 * The user's live sessions, most recently active first.
 *
 * `updated_at` is the activity marker rather than `refreshed_at`, which sounds
 * like the better column and is not: it is `timestamp without time zone` where
 * every neighbour is `timestamptz`, so folding it in would reinterpret it in
 * whatever timezone the connection happens to hold. It is also null on every
 * row this deployment has. `updated_at` moves when GoTrue refreshes a session,
 * which is the thing being reported.
 *
 * **Supabase does not time-box sessions by default**, so `not_after` is
 * typically null and an old row is a genuinely signed-in device rather than a
 * stale record. Only a session that has actually been given an expiry is hidden.
 */
export async function listUserSessions(userId: string): Promise<ActiveSession[]> {
  const currentId = await currentSessionId();

  /**
   * **The timestamps are formatted in SQL, not in JS.** postgres.js decides for
   * itself whether a `timestamptz` arrives as a `Date` or as text, and on this
   * connection it is text — in Postgres' own `2026-09-07 09:47:42.131843+00`
   * shape, which `new Date()` parses only by browser leniency. Rendering the
   * ISO-8601 string in the query removes the guess: what comes back is what the
   * API returns, whatever the driver decides tomorrow.
   */
  const rows = (await sql`
    select id::text as id,
           user_agent,
           host(ip)  as ip,
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
           to_char(coalesce(updated_at, created_at) at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')                                as last_active_at
    from auth.sessions
    where user_id = ${userId}::uuid
      and (not_after is null or not_after > now())
    order by coalesce(updated_at, created_at) desc
    limit 100
  `) as unknown as SessionRow[];

  return rows.map((r) => serialize(r, currentId));
}

/**
 * Ends one session. Returns false when the id is not this user's — which the
 * route reports as a 404, so it cannot be used to probe for the existence of
 * someone else's session.
 *
 * **The delete is the revocation, not a flag beside it.** `auth.refresh_tokens`
 * and `auth.mfa_amr_claims` both cascade from `auth.sessions` (verified against
 * the live schema: `ON DELETE CASCADE` on each), so the refresh chain is gone
 * with the row and the session can never mint another access token.
 *
 * **What it does not do is invalidate an access token already issued.** Those
 * are signed JWTs that nothing consults a database about, so a revoked session
 * keeps working until its current token expires — an hour on Supabase's default
 * — and then dies at the refresh. Closing that window means checking a denylist
 * on every authenticated request, which is a real cost on the hot auth path and
 * a new way to lock every merchant out if it ever misfires. The window is
 * documented in `docs/API.md` §16 rather than papered over.
 */
export async function revokeUserSession(userId: string, sessionId: string): Promise<boolean> {
  if (!isUuid(sessionId)) return false;

  const deleted = await sql`
    delete from auth.sessions
    where id = ${sessionId}::uuid and user_id = ${userId}::uuid
    returning id
  `;
  return deleted.length > 0;
}
