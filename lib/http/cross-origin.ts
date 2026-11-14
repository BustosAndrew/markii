/**
 * Refuse a browser's cross-origin write that carries cookies.
 *
 * **Why `SameSite=Lax` is not enough here.** Lax withholds cookies on a
 * *cross-site* POST, and "site" means the registrable domain — so
 * `evil.markii.shop` and `markii.shop` are the **same site**, and a request
 * from one to the other carries the other's cookies. While storefronts could
 * run no script that did not matter. Merchant scripts (D51 M6 — head code on
 * `{slug}.markii.shop`) make it matter: a script on one store could
 * `fetch("https://markii.shop/api/actions/…", { method: "POST", credentials:
 * "include", body })` with a `text/plain` body — no preflight — and act as any
 * merchant who visits that store. The same holds between two storefronts for a
 * shopper's session.
 *
 * Browsers say where a request came from: `Sec-Fetch-Site` everywhere current,
 * `Origin` on every cross-origin POST in older ones. A write that a browser
 * marks as coming from another origin and that carries a cookie is refused. A
 * request with neither header is not a browser acting for a page — a server,
 * `curl`, a webhook, the test suite — and cannot be riding a visitor's
 * ambient cookies, so it passes.
 *
 * Proxy-bundle code: no database, no `node:` imports.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type CrossOriginFacts = {
  method: string;
  /** The request's own host, as the browser addressed it. */
  host: string;
  hasCookie: boolean;
  secFetchSite: string | null;
  origin: string | null;
};

export function crossOriginWriteRefused(f: CrossOriginFacts): boolean {
  if (SAFE_METHODS.has(f.method.toUpperCase())) return false;
  if (!f.hasCookie) return false;
  const site = f.secFetchSite?.toLowerCase() ?? null;
  // "none" is a navigation the person started themselves (typed, bookmarked).
  if (site) return site !== "same-origin" && site !== "none";
  if (!f.origin || f.origin === "null") return f.origin === "null";
  try {
    return new URL(f.origin).host.toLowerCase() !== f.host.toLowerCase();
  } catch {
    return true;
  }
}

export const CROSS_ORIGIN_REFUSAL = {
  error: {
    code: "CROSS_ORIGIN_REFUSED",
    message: "This request came from another site and carried cookies, so it was refused.",
  },
} as const;
