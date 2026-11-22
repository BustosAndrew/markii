/**
 * The rules for storefront redirects (`site_redirects`), pure so the action,
 * the storefront and a test all apply the same ones.
 *
 * A redirect fires only where the storefront would otherwise answer 404, so
 * the rules below are about two things: matching an old link however it was
 * pasted, and refusing a rule that could never fire or that sends a shopper
 * somewhere unsafe.
 */

export const REDIRECT_PATH_MAX = 1000;
export const REDIRECT_TARGET_MAX = 2000;
export const REDIRECTS_PER_SITE = 10_000;
/** One `redirects.import` call. A Shopify catalogue past this goes in several. */
export const REDIRECT_IMPORT_MAX = 1000;

/**
 * Paths a redirect could never fire on — they always answer, or belong to the
 * platform — so a rule there would sit in the list doing nothing. Matched on a
 * segment boundary: `/cart` and `/cart/x`, never `/cartography`.
 */
export const RESERVED_REDIRECT_PATHS = [
  "/api",
  "/_next",
  "/cart",
  "/account",
  "/download",
  "/search",
  "/llms.txt",
  "/llms-full.txt",
  "/agent.md",
  "/sitemap.xml",
  "/robots.txt",
  "/blog/feed.xml",
] as const;

/**
 * Paths that always answer but whose children may not: `/collections` is the
 * index, while `/collections/old-handle` 404s and is exactly what an old
 * Shopify link looks like.
 */
export const ALWAYS_ANSWERED_PATHS = ["/", "/collections", "/blog"] as const;

export class RedirectRuleError extends Error {
  constructor(
    message: string,
    public field: "from" | "to",
  ) {
    super(message);
  }
}

/**
 * An old link as the storefront will match it: the path alone (a full URL
 * from the old store is accepted and its host dropped), decoded, slashes
 * collapsed, no trailing slash, lower case — old platforms' URLs are not
 * case-sensitive, and a merchant pasting `/Products/Tea/` means `/products/tea`.
 */
export function normalizeRedirectPath(input: string): string {
  let raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      throw new RedirectRuleError("That is not a link this store can match.", "from");
    }
  }
  if (!raw.startsWith("/")) throw new RedirectRuleError("An old link starts with / (or is a full URL from the old store).", "from");
  raw = raw.replace(/[?#].*$/, "");
  try {
    raw = decodeURI(raw);
  } catch {
    // A malformed escape is matched as written rather than refused: it is what the old link holds.
  }
  const path = (raw.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/").toLowerCase();
  if (path.length > REDIRECT_PATH_MAX) throw new RedirectRuleError(`An old link is at most ${REDIRECT_PATH_MAX} characters.`, "from");
  if (/[\s\\]/.test(path)) throw new RedirectRuleError("An old link cannot contain spaces or backslashes.", "from");
  return path;
}

/** The source as stored, or a refusal saying why the rule could never fire. */
export function checkRedirectFrom(input: string): string {
  const path = normalizeRedirectPath(input);
  if ((ALWAYS_ANSWERED_PATHS as readonly string[]).includes(path)) {
    throw new RedirectRuleError(`${path} always answers, so a redirect from there would never fire.`, "from");
  }
  const reserved = RESERVED_REDIRECT_PATHS.find((p) => path === p || path.startsWith(`${p}/`));
  if (reserved) throw new RedirectRuleError(`${reserved} belongs to the storefront itself, so a redirect from there would never fire.`, "from");
  return path;
}

/**
 * The target as stored: a path on this store, or an absolute `https://` URL.
 * Refused: `http:` (a shopper sent off https), any other scheme, protocol-
 * relative `//host` (which looks like a path and leaves the store), and
 * credentials in the URL.
 */
export function checkRedirectTarget(input: string): string {
  const to = input.trim();
  if (to.length === 0) throw new RedirectRuleError("Say where the old link should go.", "to");
  if (to.length > REDIRECT_TARGET_MAX) throw new RedirectRuleError(`A target is at most ${REDIRECT_TARGET_MAX} characters.`, "to");
  if (/[\s\\]/.test(to)) throw new RedirectRuleError("A target cannot contain spaces or backslashes.", "to");
  if (to.startsWith("/")) {
    if (to.startsWith("//")) throw new RedirectRuleError("Start a path on this store with a single /, or give a full https:// URL.", "to");
    return to;
  }
  let url: URL;
  try {
    url = new URL(to);
  } catch {
    throw new RedirectRuleError("A target is a path on this store (/p/green-tea) or a full https:// URL.", "to");
  }
  if (url.protocol !== "https:") throw new RedirectRuleError("Only https:// links — anything else is blocked or unsafe for shoppers.", "to");
  if (url.username || url.password) throw new RedirectRuleError("A target cannot carry a username or password.", "to");
  return url.toString();
}

/** The path a target would be matched as, when it points at this store — for loop checks. */
export function internalTargetPath(to: string): string | null {
  if (!to.startsWith("/")) return null;
  try {
    return normalizeRedirectPath(to);
  } catch {
    return null;
  }
}

/**
 * Whether adding `from → to` closes a loop with the rules that exist. Only
 * missing paths redirect, so a loop of them would bounce a shopper's browser
 * between them until it gave up. `existing` maps a stored source to its
 * target; the walk is bounded by its size.
 */
export function closesLoop(from: string, to: string, existing: Map<string, string>): boolean {
  let at = internalTargetPath(to);
  const seen = new Set<string>();
  while (at !== null && !seen.has(at)) {
    if (at === from) return true;
    seen.add(at);
    const next = existing.get(at);
    at = next === undefined ? null : internalTargetPath(next);
  }
  return false;
}

/** Where a stored target sends the shopper, given the store's own base URL. */
export function resolveRedirectTarget(to: string, baseUrl: string): string {
  return to.startsWith("/") ? `${baseUrl.replace(/\/+$/, "")}${to}` : to;
}
