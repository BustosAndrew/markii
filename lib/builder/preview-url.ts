/**
 * Where the builder's live preview is served (D51, M2) — pure, so `proxy.ts`
 * can import it. **No database, no `node:` imports** (the proxy bundle).
 *
 * **On its own origin in production**: `https://preview.{ROOT_DOMAIN}/t/{token}/{slug}/…`.
 * The dashboard's session cookies are host-only, so they never reach it, and
 * when custom code arrives (M6) it runs nowhere near an admin session.
 *
 * **The token is in the path, not a cookie.** A cookie inside the editor's
 * iframe would be a third-party cookie on many setups (`localhost` and
 * `preview.localhost` are different sites to a browser), and browsers block
 * those. With the token in the path, every link the storefront renders — built
 * from `baseUrl` — stays inside the preview without any cookie at all.
 * Responses send `Referrer-Policy: no-referrer` so it never leaks through a
 * link, and the token only ever grants a two-hour read of one site's draft.
 *
 * Where storefront subdomains do not load (`localhost`, `*.vercel.app` —
 * the same rule as `tenantBaseUrl`), the preview falls back to a path on the
 * app, `/preview/t/{token}/{slug}`, exactly as storefronts themselves do there.
 * That fallback is refused when subdomains work, so production never serves a
 * draft on the dashboard's origin.
 */

export const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PREVIEW_PATH_PREFIX = "/preview/t/";
/** Set by `proxy.ts` on a rewritten preview request; validated against the database in `loadSite`. */
export const PREVIEW_TOKEN_HEADER = "x-markii-preview-token";

function rootDomain(): string {
  return (process.env.ROOT_DOMAIN ?? "").replace(/^\.|\/$/g, "").toLowerCase();
}

export function previewSubdomainWorks(root = rootDomain()): boolean {
  return Boolean(root) && !root.endsWith(".vercel.app") && root !== "localhost" && !root.startsWith("localhost:");
}

export function previewHost(root = rootDomain()): string | null {
  return previewSubdomainWorks(root) ? `preview.${root}` : null;
}

/** The preview's base URL for a site — every storefront link inside the preview is built on it. */
export function previewBase(slug: string, token: string, appOrigin: string, root = rootDomain()): string {
  return previewSubdomainWorks(root)
    ? `https://preview.${root}/t/${token}/${slug}`
    : `${appOrigin.replace(/\/$/, "")}${PREVIEW_PATH_PREFIX}${token}/${slug}`;
}

export type PreviewRequest = { token: string; slug: string; rest: string };

/**
 * A preview request, or null. Recognises the preview host (`/t/{token}/{slug}/…`)
 * and, only where subdomains do not work, the path form on any host.
 */
export function parsePreviewRequest(host: string, pathname: string, root = rootDomain()): PreviewRequest | null {
  let tail: string | null = null;
  const pHost = previewHost(root);
  if (pHost && host === pHost && pathname.startsWith("/t/")) tail = pathname.slice("/t/".length);
  else if (!previewSubdomainWorks(root) && pathname.startsWith(PREVIEW_PATH_PREFIX)) {
    tail = pathname.slice(PREVIEW_PATH_PREFIX.length);
  }
  if (tail === null) return null;

  const [token, slug, ...rest] = tail.split("/");
  if (!token || !PREVIEW_TOKEN_PATTERN.test(token)) return null;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  return { token, slug, rest: rest.length ? `/${rest.join("/")}` : "" };
}
