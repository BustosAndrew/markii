import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import {
  PREVIEW_TOKEN_HEADER,
  parsePreviewRequest,
  previewHost,
  type PreviewRequest,
} from "./lib/builder/preview-url";
import { normalizeHost, resolveCustomDomain } from "./lib/domains";
import { CROSS_ORIGIN_REFUSAL, crossOriginWriteRefused } from "./lib/http/cross-origin";
import {
  cspHeaderName,
  cspMode,
  dashboardOriginForProxy,
  isSensitiveStorefrontPath,
  newNonce,
  storefrontCsp,
} from "./lib/storefront/csp";
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

/**
 * Storefront Content-Security-Policy (D51 M6, `lib/storefront/csp.ts`).
 *
 * A fresh nonce per request, set on the **request** as well as the response:
 * Next reads the nonce out of the request's CSP header and stamps it on its own
 * scripts, and `x-nonce` is how a server component (the merchant's head code,
 * the preview bridge) reads it to stamp ours. API routes get none — they serve
 * JSON, and nothing in them renders a script.
 */
type Csp = { headers: Headers; apply<T extends Response>(res: T): T };

function storefrontCspFor(req: NextRequest, rest: string, opts: { preview: boolean }): Csp {
  const headers = new Headers(req.headers);
  // Never trust a nonce or policy a client sent.
  headers.delete("x-nonce");
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  const mode = cspMode();
  const isApi = rest === "/api" || rest.startsWith("/api/");
  if (mode === "off" || isApi) return { headers, apply: (res) => res };
  const nonce = newNonce();
  const policy = storefrontCsp({
    nonce,
    sensitive: isSensitiveStorefrontPath(rest),
    frameAncestor: opts.preview ? dashboardOriginForProxy() : null,
    dev: process.env.NODE_ENV === "development",
    https: process.env.NODE_ENV === "production" && req.nextUrl.protocol === "https:",
  });
  headers.set("x-nonce", nonce);
  // Next looks for the nonce here whichever mode the response is in.
  headers.set("content-security-policy", policy);
  return {
    headers,
    apply: (res) => {
      res.headers.set(cspHeaderName(mode), policy);
      return res;
    },
  };
}

/**
 * The builder's live preview (D51): `/t/{token}/{slug}/…` on the preview host
 * (or `/preview/t/…` where subdomains do not work) becomes the storefront page
 * with the token attached. The token is only *carried* here; `loadSite`
 * checks it against the database, so a request that invents the header gains
 * nothing.
 *
 * Storefront API calls are refused outright — no cart, checkout, sign-in or
 * download happens against a draft — and nothing here is throttled or logged
 * as traffic, because the only visitor is the merchant at the editor.
 */
function previewResponse(req: NextRequest, preview: PreviewRequest): NextResponse {
  const guard = {
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "cache-control": "no-store",
  };
  if (preview.rest === "/api" || preview.rest.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Checkout, carts and accounts are turned off in the design preview." } },
      { status: 403, headers: guard },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = `/_sites/${preview.slug}${preview.rest}`;
  const csp = storefrontCspFor(req, preview.rest, { preview: true });
  csp.headers.set(PREVIEW_TOKEN_HEADER, preview.token);
  const res = NextResponse.rewrite(url, { request: { headers: csp.headers } });
  for (const [k, v] of Object.entries(guard)) res.headers.set(k, v);
  return csp.apply(res);
}

/** Signed-in-only areas of the platform. Everything else is public. */
function isProtectedPath(pathname: string) {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const waitUntil = (work: Promise<unknown>) => event.waitUntil(work);

  /**
   * First, on every host: a browser write from another origin carrying cookies
   * is refused (`lib/http/cross-origin.ts`). Sibling subdomains are the same
   * *site*, so `SameSite=Lax` does not stop one storefront's script — merchant
   * head code — from posting to the dashboard or another store with a
   * visitor's cookies attached.
   */
  if (
    crossOriginWriteRefused({
      method: req.method,
      host: req.headers.get("host") ?? "",
      hasCookie: Boolean(req.headers.get("cookie")),
      secFetchSite: req.headers.get("sec-fetch-site"),
      origin: req.headers.get("origin"),
    })
  ) {
    return NextResponse.json(CROSS_ORIGIN_REFUSAL, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const requestHost = normalizeHost(req.headers.get("host") ?? "");
  const preview = parsePreviewRequest(requestHost, req.nextUrl.pathname);
  if (preview) return previewResponse(req, preview);
  // The preview host serves previews and nothing else — never a store whose slug is "preview".
  if (requestHost === previewHost()) return new NextResponse("Not found", { status: 404 });

  /**
   * A storefront addressed by path. Answered before the platform-host branch so
   * it never touches the staff session refresh — shoppers are a separate
   * identity domain (D32), which is why `_sites` was excluded from the matcher
   * before the throttle needed to see it.
   */
  const directSlug = storefrontSlugFromPath(req.nextUrl.pathname);
  if (directSlug) {
    const throttled = throttleStorefront(req, directSlug, waitUntil);
    if (throttled) return throttled;
    const rest = req.nextUrl.pathname.replace(/^\/_sites\/[^/]+/, "") || "/";
    const csp = storefrontCspFor(req, rest, { preview: false });
    return csp.apply(NextResponse.next({ request: { headers: csp.headers } }));
  }

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
  const csp = storefrontCspFor(req, url.pathname, { preview: false });
  url.pathname = `/_sites/${slug}${url.pathname === "/" ? "" : url.pathname}`;
  return csp.apply(NextResponse.rewrite(url, { request: { headers: csp.headers } }));
}
