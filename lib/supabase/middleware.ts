import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SESSION_COOKIE_OPTIONS } from "./server";

function getEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

/**
 * Refreshes the Supabase session on the way through `proxy.ts`.
 *
 * Expiry is never the client's problem (D30): the browser holds an httpOnly
 * cookie it cannot read, so it has no way to notice a token has aged out. This
 * runs on dashboard requests and rewrites the cookie when Supabase hands back a
 * newer one.
 *
 * Returns the user alongside the response so the caller can gate `/dashboard`
 * without a second round trip.
 */
export async function updateSupabaseSession(request: NextRequest): Promise<{
  response: NextResponse;
  userId: string | null;
  configured: boolean;
}> {
  const env = getEnv();
  const response = NextResponse.next({ request });

  if (!env) return { response, userId: null, configured: false };

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          // Both stores: the request copy so anything downstream in this pass
          // sees the refreshed token, and the response so the browser keeps it.
          request.cookies.set(name, value);
          response.cookies.set(name, value, { ...options, ...SESSION_COOKIE_OPTIONS });
        }
      },
    },
  });

  try {
    // `getUser()` revalidates against Supabase rather than trusting the cookie's
    // own claims — `getSession()` would not, and a forged cookie would pass.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { response, userId: user?.id ?? null, configured: true };
  } catch (e) {
    // An auth outage must not take the storefronts down with it.
    console.error("session refresh failed", e);
    return { response, userId: null, configured: true };
  }
}
