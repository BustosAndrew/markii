import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { normalizeHost, resolveCustomDomain } from "./lib/domains";
import { storefrontSlugFromPath } from "./lib/storefront/fair-use";
import { throttleStorefront } from "./lib/storefront/fair-use-guard";
import { updateSupabaseSession } from "./lib/supabase/middleware";

// Host-header multi-tenancy (Next 16 "proxy" convention): platform hosts pass through; {slug}.{ROOT_DOMAIN},
// {slug}.localhost and custom domains rewrite to /_sites/{slug}/...
//
// `_sites` is matched (it used to be excluded) so a direct `/_sites/{slug}/…`
// request is counted by the storefront throttle like one arriving by hostname —
// otherwise the throttle is stepped around by asking for the same page by path.
export const config = {
  matcher: ["/((?!_next|uploads|favicon\\.ico|icon\\.svg).*)"],
};

/** Signed-in-only areas of the platform. Everything else is public. */
function isProtectedPath(pathname: string) {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const waitUntil = (work: Promise<unknown>) => event.waitUntil(work);

  /**
   * A storefront addressed by path. Answered before the platform-host branch so
   * it never touches the staff session refresh — shoppers are a separate
   * identity domain (D32), which is why `_sites` was excluded from the matcher
   * before the throttle needed to see it.
   */
  const directSlug = storefrontSlugFromPath(req.nextUrl.pathname);
  if (directSlug) return throttleStorefront(req, directSlug, waitUntil) ?? NextResponse.next();

  const host = normalizeHost(req.headers.get("host") ?? "");
  const root = normalizeHost(process.env.ROOT_DOMAIN ?? "");

  const isPlatformHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("app.") ||
    host.endsWith(".vercel.app") ||
    (root !== "" && (host === root || host === `www.${root}`));

  if (isPlatformHost) {
    // Session refresh happens here, not in the client: the browser holds an
    // httpOnly cookie it cannot read, so it has no way to notice a token has
    // aged out (D30). Storefront hosts are skipped entirely — shoppers are a
    // separate identity domain and must never touch a staff session.
    const { response, userId, configured } = await updateSupabaseSession(req);

    if (configured && !userId && isProtectedPath(req.nextUrl.pathname)) {
      const signIn = req.nextUrl.clone();
      signIn.pathname = "/sign-in";
      signIn.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
      return NextResponse.redirect(signIn);
    }

    // When auth is unconfigured the dashboard stays reachable, so a local
    // checkout without Supabase credentials is not a blank wall. It is a
    // development affordance, not a bypass: every route still resolves its own
    // session, and `/api/me` answers 401 regardless.
    return response;
  }

  let slug: string | null = null;
  if (host.endsWith(".localhost")) {
    slug = host.slice(0, -".localhost".length);
  } else if (root && host.endsWith(`.${root}`)) {
    slug = host.slice(0, -(root.length + 1));
  } else {
    // Cached in `lib/domains.ts` — this was a database query on every request.
    slug = await resolveCustomDomain(host);
  }
  if (!slug) return NextResponse.next();

  // Storefront fair use (G12): counted once, here — the rewrite below does not
  // pass back through the proxy. The count is written in the background.
  const throttled = throttleStorefront(req, slug, waitUntil);
  if (throttled) return throttled;

  const url = req.nextUrl.clone();
  url.pathname = `/_sites/${slug}${url.pathname === "/" ? "" : url.pathname}`;
  return NextResponse.rewrite(url);
}
