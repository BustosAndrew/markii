/**
 * The storefront's Content-Security-Policy (D51 M6).
 *
 * **What it is for.** Merchant custom HTML is rebuilt from an allowlist, so no
 * script should ever reach a page through it — this is the second wall for the
 * day that is wrong, or a product description or a builder block escapes in a
 * way nobody foresaw. Only scripts carrying this request's nonce run: Next's
 * own, the islands', the preview bridge, and the merchant's head code, which is
 * written by a person holding `cms.scripts` and rendered by us with the nonce.
 * `'strict-dynamic'` lets a trusted script load what it needs (Stripe.js,
 * a tag manager's tags) without listing hosts — the shape Google recommends for
 * a strict policy, and the only one a tag manager survives.
 *
 * **Two strengths, decided by path.** The cart and account pages — where
 * shoppers type card details and passwords, and where no merchant code is ever
 * rendered — allow connections, frames and images only to the store itself and
 * Stripe. Every other page allows `https:` for those, because head code exists
 * to load analytics and pixels, and a pixel that cannot report is a support
 * ticket. The script rule is the same on both.
 *
 * Proxy-bundle code: no database, no `node:` imports.
 */

export type CspMode = "enforce" | "report-only" | "off";

/** `STOREFRONT_CSP` — `enforce` unless set otherwise. Anything unrecognised enforces. */
export function cspMode(raw = process.env.STOREFRONT_CSP): CspMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "report-only" ? v : "enforce";
}

export function cspHeaderName(mode: CspMode): string {
  return mode === "report-only" ? "content-security-policy-report-only" : "content-security-policy";
}

/** 128 random bits, base64. Web Crypto, so it runs in the proxy. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Paths where shoppers type secrets. Kept in step with `StoreTop`/`StoreFooter` `minimal`. */
export function isSensitiveStorefrontPath(rest: string): boolean {
  const p = rest.split("?")[0].replace(/\/+$/, "") || "/";
  return p === "/cart" || p === "/account" || p.startsWith("/account/");
}

const STRIPE = {
  frames: ["https://js.stripe.com", "https://*.js.stripe.com", "https://hooks.stripe.com", "https://*.stripe.com", "https://*.stripe.network"],
  connect: ["https://api.stripe.com", "https://*.stripe.com", "https://*.stripe.network", "https://maps.googleapis.com"],
  images: ["https://*.stripe.com"],
};
const VIDEO_FRAMES = ["https://www.youtube-nocookie.com", "https://player.vimeo.com"];
const FONTS_CSS = "https://fonts.googleapis.com";
const FONTS = "https://fonts.gstatic.com";

export type CspInput = {
  nonce: string;
  /** Cart and account. */
  sensitive: boolean;
  /** The builder preview: framed by the dashboard, and nothing else. */
  frameAncestor?: string | null;
  dev?: boolean;
  /** Add `upgrade-insecure-requests` — production over HTTPS only (it breaks http://localhost). */
  https?: boolean;
};

export function storefrontCsp(i: CspInput): string {
  const open = !i.sensitive;
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    // The host and 'unsafe-inline' entries are ignored by every browser that
    // understands 'strict-dynamic' and exist only for those that do not.
    ["script-src", [`'nonce-${i.nonce}'`, "'strict-dynamic'", "https:", "'unsafe-inline'", ...(i.dev ? ["'unsafe-eval'"] : [])]],
    // Inline <style> elements and style attributes are how themes, blocks and
    // custom CSS arrive; none can run script.
    ["style-src", ["'self'", "'unsafe-inline'", open ? "https:" : FONTS_CSS]],
    ["font-src", ["'self'", "data:", open ? "https:" : FONTS]],
    ["img-src", ["'self'", "data:", "blob:", ...(open ? ["https:"] : ["https:", ...STRIPE.images])]],
    ["media-src", ["'self'", ...(open ? ["https:"] : [])]],
    ["connect-src", ["'self'", ...(open ? ["https:"] : STRIPE.connect)]],
    ["frame-src", ["'self'", ...(open ? ["https:"] : [...STRIPE.frames, ...VIDEO_FRAMES])]],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    // A verified custom domain and the store's own subdomain post to each
    // other (`baseUrl` is the canonical address), so this cannot be 'self'.
    ["form-action", ["'self'", "https:"]],
    ["frame-ancestors", i.frameAncestor ? [i.frameAncestor] : ["'none'"]],
  ];
  const parts = directives.map(([k, v]) => `${k} ${dedupe(v).join(" ")}`);
  if (i.https) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

function dedupe(v: string[]): string[] {
  return [...new Set(v)];
}

/** The dashboard's origin, which frames the preview. Mirrors `appUrl()` without its imports. */
export function dashboardOriginForProxy(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  const raw = explicit ? explicit.replace(/\/$/, "") : vercel ? `https://${vercel.replace(/\/$/, "")}` : "http://localhost:3000";
  try {
    return new URL(raw).origin;
  } catch {
    return "http://localhost:3000";
  }
}
