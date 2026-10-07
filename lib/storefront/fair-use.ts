/**
 * Storefront fair use (G12) — the pure half: which store a request is for, the
 * counter keys, and what a throttled caller is told.
 *
 * The counting is in `./fair-use-guard`, split for the reason `rate-limit` is
 * split from `rate-limit-store`: this is what is worth testing, and it must not
 * drag a database into the tests that touch it.
 */

/**
 * The store a direct `/_sites/{slug}/…` path is for, or null.
 *
 * Storefront hosts reach `/_sites/` by rewrite inside the proxy, but the path
 * is also public on the platform host. A throttle that only watched hostnames
 * would be stepped around by requesting the same page by its path, so the
 * proxy reads the slug from either.
 */
export function storefrontSlugFromPath(pathname: string): string | null {
  const match = /^\/_sites\/([^/]+)/.exec(pathname);
  if (!match) return null;
  try {
    const slug = decodeURIComponent(match[1]!).toLowerCase();
    return slug === "" ? null : slug;
  } catch {
    // A malformed escape is not a store. The route will 404 it on its own.
    return null;
  }
}

/**
 * Counter key for one client address on one store.
 *
 * An IP is personal data in some readings, but it is already what the auth
 * limits key on and the counter row is swept a day after its window ends — the
 * same retention the audit log's `ip_address` does not get.
 */
export function storefrontLimitKey(slug: string, ip: string): string {
  return `sf:${slug}:${ip}`;
}

/**
 * Counter key for one download grant — its **id**, never its token.
 *
 * The token is the shopper's only credential (`/download/:token`), and
 * `rate_limit_counters` holds ids, never secrets.
 */
export function downloadLimitKey(grantId: number): string {
  return `dl:${grantId}`;
}

/**
 * What a throttled storefront caller reads.
 *
 * Plain text, because the caller is as likely to be an agent as a browser and
 * both can read it. It points agents at the two documents that answer most
 * questions in one request — the cheapest way to stop being throttled is to
 * stop crawling every page, and saying so is more useful than the 429 alone.
 */
export function throttledStorefrontBody(retryAfterSeconds: number): string {
  return (
    `Too many requests to this store from your address. Retry in ${retryAfterSeconds}s.\n\n` +
    "Agents: /llms.txt describes this store and /api/search?q= answers catalogue questions " +
    "in one request, without crawling every page.\n"
  );
}

/** "3 hours" / "1 minute" — whole units, never "0 minutes". */
export function retryWindowCopy(retryAfterSeconds: number): string {
  if (retryAfterSeconds >= 3600) {
    const hours = Math.ceil(retryAfterSeconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
