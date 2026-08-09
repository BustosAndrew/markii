import { apiPost } from "./client";
import { callWhenLive } from "./planned";

const AUTH_SECTION = "API §16";

/**
 * Flip together with the §16 status badge in `docs/API.md` — same change, both
 * sides — or the routes ship to nobody.
 */
const AUTH_API_LIVE = true;

export function isAuthApiLive() {
  return AUTH_API_LIVE;
}

export type Credentials = { email: string; password: string };

/**
 * Auth mutations run server-side only (D30). These routes are Markii's own
 * origin: the server sets the httpOnly session cookie, the browser never talks
 * to Supabase Auth, and identity is read from `GET /api/me` — never from a
 * client-side session.
 */
export function signIn(body: Credentials, init?: RequestInit) {
  return callWhenLive(AUTH_API_LIVE, AUTH_SECTION, () =>
    apiPost<void>("/api/auth/sign-in", body, init),
  );
}

export function signUp(body: Credentials, init?: RequestInit) {
  return callWhenLive(AUTH_API_LIVE, AUTH_SECTION, () =>
    apiPost<{ ok: true; emailConfirmationRequired: boolean }>(
      "/api/auth/sign-up",
      body,
      init,
    ),
  );
}

export function signOut(init?: RequestInit) {
  return callWhenLive(AUTH_API_LIVE, AUTH_SECTION, () =>
    apiPost<void>("/api/auth/sign-out", undefined, init),
  );
}

/** Always resolves for a well-formed address — the route never reveals whether an account exists. */
export function requestPasswordReset(body: { email: string }, init?: RequestInit) {
  return callWhenLive(AUTH_API_LIVE, AUTH_SECTION, () =>
    apiPost<void>("/api/auth/reset-password", body, init),
  );
}

/** Authorized by the recovery session the callback route established. */
export function updatePassword(body: { password: string }, init?: RequestInit) {
  return callWhenLive(AUTH_API_LIVE, AUTH_SECTION, () =>
    apiPost<void>("/api/auth/update-password", body, init),
  );
}
