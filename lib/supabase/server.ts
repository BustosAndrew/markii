import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client. **The only kind that exists in this codebase.**
 *
 * D30: every auth mutation runs server-side, because a cookie written by
 * `document.cookie` cannot carry `HttpOnly` — merchant custom code runs on
 * storefronts, and XSS there must never reach an admin session. If a
 * `createBrowserClient` ever reappears in `lib/supabase/`, that decision has been
 * quietly reversed.
 */

function getEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

/**
 * Cookie flags for every session cookie we write. `httpOnly` is the whole point
 * of D30; `secure` is relaxed only on localhost, where there is no HTTPS to
 * attach it to and the browser would otherwise drop the cookie silently.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
} as const;

export async function getSupabaseServerClient(): Promise<SupabaseClient | null> {
  const env = getEnv();
  if (!env) return null;

  const cookieStore = await cookies();

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      /**
       * `getAll`/`setAll`, not the `get`/`set`/`remove` triple: the triple is
       * deprecated in `@supabase/ssr` ≥ 0.10 and drops chunked-cookie handling,
       * which large sessions (many claims, or an org list) need.
       */
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, { ...options, ...SESSION_COOKIE_OPTIONS });
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. Safe to
          // ignore: `proxy.ts` refreshes the session on every dashboard request,
          // so the write happens there instead.
        }
      },
    },
  });
}

export function isSupabaseServerConfigured() {
  return Boolean(getEnv());
}
