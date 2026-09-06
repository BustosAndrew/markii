import "server-only";

/**
 * Where a request came from, for the audit log (§16).
 *
 * Separate from *who* made it: identity is resolved from a cookie or a token
 * hash, both of which the caller must possess. This is transport metadata, and
 * the distinction matters when reading it back — an IP is a lead during an
 * incident, never proof of identity.
 */
export type RequestContext = {
  ip: string | null;
  userAgent: string | null;
};

/**
 * **`x-forwarded-for` is trusted here because Vercel overwrites it at the
 * edge**, so the leftmost entry is the real client rather than something the
 * client wrote. That trust does not survive being run behind a different proxy,
 * or none: on a bare origin any caller can set the header to whatever they
 * like, and an audit row would record the lie. It is recorded as a lead, never
 * as an authorization input, which is what keeps the blast radius to a
 * misleading log line rather than a bypass.
 *
 * `x-real-ip` is the fallback because some platform paths set only that one.
 *
 * **Null rather than a placeholder.** A non-HTTP caller — a seed, a migration,
 * the scheduled sweep — genuinely has no address, and writing `"unknown"` would
 * make an absent fact look like a recorded one.
 */
export function requestContextFrom(req: Request): RequestContext {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip")?.trim() || null;

  /**
   * Capped because this is stored verbatim on every invocation and a user agent
   * is attacker-controlled free text — an unbounded one is a cheap way to bloat
   * a table nobody prunes.
   */
  const ua = req.headers.get("user-agent");
  return { ip: ip ?? null, userAgent: ua ? ua.slice(0, 512) : null };
}
