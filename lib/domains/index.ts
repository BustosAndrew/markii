import { and, eq } from "drizzle-orm";
import { db, isDatabaseConfigured, sites } from "../db";

/**
 * Host → site-slug resolution for custom domains.
 *
 * This sits on the hot path of **every custom-domain storefront request**, before
 * anything renders. The original implementation ran `select slug from sites where
 * custom_domain = $1` inline in `proxy.ts`, so a shopper in Singapore paid a
 * trans-Pacific round trip just to learn which site they had asked for
 * (`docs/BACKEND.md` §0, `docs/DECISIONS.md` D6 task 3).
 *
 * Custom domains change perhaps twice in a site's life and are read on every
 * request, so the mapping is cached rather than queried. A miss costs one query
 * per host per instance per TTL instead of one per request.
 *
 * **Negative results are cached too.** Without that, traffic to a hostname that
 * points at Markii but was never connected — stale DNS, or someone aiming a
 * domain at us on purpose — is an unbounded stream of database queries from
 * unauthenticated requests (G12).
 *
 * **Nothing here may import `node:dns`.** This module is pulled into the proxy
 * bundle; the verification lookups live in `./verification`, which the proxy
 * never touches.
 */

const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 60_000;

/** Bounded so an attacker cycling hostnames cannot grow the map without limit. */
const MAX_ENTRIES = 5_000;

type Entry = { slug: string | null; expiresAt: number };

/**
 * Survives dev module reloads, and is per-instance in production. Instances do
 * not share it: an invalidation clears the instance that served the write, and
 * every other instance corrects itself within one TTL. That bound is the reason
 * the TTL is minutes rather than hours.
 */
const globalForDomains = globalThis as unknown as { markiiDomainCache?: Map<string, Entry> };
const cache = (globalForDomains.markiiDomainCache ??= new Map<string, Entry>());

export function normalizeHost(host: string): string {
  return host.split(":")[0].trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Returns the site slug a custom domain maps to, or `null`.
 *
 * **Only a `verified` domain resolves** (migration 0031). A pending claim is a
 * merchant asserting they own a hostname, and routing on an assertion is how one
 * org ends up answering for another company's domain the moment its DNS points
 * here. The unique index guarantees at most one verified holder, so the `limit 1`
 * below is now deterministic rather than whichever row the planner returned.
 *
 * Never throws: a resolution failure must degrade to "not a tenant host" and let
 * the request fall through, not 500 the storefront.
 */
export async function resolveCustomDomain(host: string): Promise<string | null> {
  const key = normalizeHost(host);
  if (!key) return null;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.slug;

  if (!isDatabaseConfigured()) return null;

  let slug: string | null = null;
  try {
    const rows = await db
      .select({ slug: sites.slug })
      .from(sites)
      .where(and(eq(sites.customDomain, key), eq(sites.domainStatus, "verified")))
      .limit(1);
    slug = rows[0]?.slug ?? null;
  } catch (e) {
    console.error("custom-domain lookup failed", e);
    // Do not cache an error as a negative result — that would blackhole a live
    // storefront for the whole negative TTL over one transient database blip.
    return hit?.slug ?? null;
  }

  remember(key, slug);
  return slug;
}

function remember(key: string, slug: string | null) {
  if (cache.size >= MAX_ENTRIES) {
    // Cheap eviction: drop the oldest insertion. Map preserves insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, {
    slug,
    expiresAt: Date.now() + (slug ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

/**
 * Call on connect, verify, and disconnect so the writing instance serves the new
 * mapping immediately. Pass both the old and new hostnames on a change — the old
 * one must stop resolving as much as the new one must start.
 *
 * **Verification is a routing change too**, not just a status change: the host
 * was cached as a negative result while the claim was pending, and without this
 * the storefront stays dark for the negative TTL after it verifies.
 */
export function invalidateCustomDomain(...hosts: (string | null | undefined)[]) {
  for (const host of hosts) {
    if (!host) continue;
    cache.delete(normalizeHost(host));
  }
}

export { normalizeDomain } from "./normalize";
export {
  dnsRecordsFor,
  ownershipRecordName,
  ownershipRecordValue,
  type DnsRecord,
} from "./records";
