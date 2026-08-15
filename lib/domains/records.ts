import { normalizeDomain } from "./normalize";

/**
 * The DNS contract for a custom storefront domain (§2).
 *
 * Two records, answering two different questions, and conflating them is the
 * mistake this module exists to prevent:
 *
 * - **Ownership** — a TXT nonce only the domain's controller can publish. This
 *   is the gate. Without it `custom_domain` is just a string a merchant typed,
 *   and one org could claim another company's hostname.
 * - **Pointing** — the CNAME or A record that actually sends traffic here. This
 *   is *reported*, never a gate: it propagates on its own schedule, and a
 *   domain that is owned but not yet pointed simply receives no traffic. Making
 *   it a gate would mean a merchant who did everything right sees "failed".
 *
 * Everything here is pure and derived. Nothing is stored except the token: the
 * record names have a fixed shape, and a stored copy would be a second thing to
 * keep in sync.
 */

/** Vercel's documented targets — `vercel.json` makes that this deployment's host. */
const DEFAULT_CNAME_TARGET = "cname.vercel-dns.com";
const DEFAULT_A_RECORD = "76.76.21.21";

export type DnsRecord = {
  type: "TXT" | "CNAME" | "A";
  name: string;
  value: string;
  /** What this record is for, in the merchant's terms. */
  purpose: "ownership" | "pointing";
};

/**
 * Where the ownership record goes. Underscore-prefixed so it cannot collide with
 * a real host the merchant might want, and so it is obvious in a zone file that
 * it belongs to a verification system rather than to mail or the site itself.
 */
export function ownershipRecordName(domain: string): string {
  return `_markii-verify.${domain}`;
}

/** The exact TXT string. Prefixed so a merchant can tell whose record it is. */
export function ownershipRecordValue(token: string): string {
  return `markii-domain-verification=${token}`;
}

/**
 * 128 bits of randomness. It is a bearer secret in the weak sense — anyone who
 * can read the merchant's DNS can read it — but it must not be *guessable*,
 * because a guessed token published on an attacker's own domain would let them
 * verify a hostname they do not control.
 */
export function generateVerificationToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function cnameTarget(): string {
  return normalizeDomain(process.env.SITE_DOMAIN_CNAME_TARGET ?? "") ?? DEFAULT_CNAME_TARGET;
}

/** Explicitly configured apex IPs, or null when the deployment has not set any. */
export function configuredARecords(): string[] | null {
  const configured = (process.env.SITE_DOMAIN_A_RECORD ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : null;
}

/**
 * The apex IPs a merchant should publish, and the ones a pointed apex is
 * accepted at — deliberately the **same list**, so the instruction and the check
 * cannot disagree.
 *
 * `resolved` is what `cnameTarget()` currently resolves to, read at check time.
 * Preferring it over a constant is the fix for a real failure: the hardcoded
 * default was Vercel's historically documented `76.76.21.21`, while this
 * deployment's own apex answers on `216.198.79.1`. A merchant following the
 * instruction would publish an address that may not serve them, and the check
 * would then call a *correctly* pointed apex wrong.
 *
 * Precedence is explicit config → live resolution → the documented constant.
 * The constant survives only as a last resort for a DNS outage, because showing
 * an apex no record at all is worse than showing one that might be stale.
 */
export function aRecords(resolved: string[] = []): string[] {
  return configuredARecords() ?? (resolved.length > 0 ? resolved : [DEFAULT_A_RECORD]);
}

/**
 * Whether `domain` is an apex (`acme.com`) or a subdomain (`shop.acme.com`).
 *
 * Label counting is wrong for `acme.co.uk` and there is no public-suffix list
 * here, so this decides **only which record to suggest first**, never whether
 * verification passes. `checkPointing` accepts either record regardless of what
 * this returns, which is why being wrong about `co.uk` costs a merchant nothing
 * beyond reading one extra row of the table.
 */
export function looksLikeApex(domain: string): boolean {
  return domain.split(".").length === 2;
}

/**
 * Hostnames that are Markii's own routing and can never be a merchant's custom
 * domain. `proxy.ts` treats these as platform hosts and never consults the
 * custom-domain table, so a claim on one would sit in the database looking
 * connected while routing nothing.
 *
 * Lives here rather than beside the claim check because **two** callers need it
 * and one of them must not import `node:dns`: it is also the guard on detaching
 * a domain from the hosting platform, where the operation is an irreversible
 * DELETE against a live project.
 */
export function isReservedHost(domain: string): boolean {
  const root = normalizeDomain(process.env.ROOT_DOMAIN ?? "");
  return (
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".vercel.app") ||
    (root !== null && (domain === root || domain.endsWith(`.${root}`)))
  );
}

/**
 * The storefront's own address on Markii — `{slug}.{ROOT_DOMAIN}`.
 *
 * Null when `ROOT_DOMAIN` is unset or is a local host, which is the development
 * case: `*.localhost` resolves without any registration and there is no platform
 * to attach it to.
 */
export function tenantHost(slug: string): string | null {
  const root = normalizeDomain(process.env.ROOT_DOMAIN ?? "");
  if (!root || root === "localhost" || root.endsWith(".localhost")) return null;
  return `${slug}.${root}`;
}

/**
 * Hosts that must **never** be detached from the hosting platform.
 *
 * Narrower than {@link isReservedHost} on purpose, and the difference is the
 * whole point. `isReservedHost` answers "may a *merchant* claim this as a custom
 * domain?", for which every `{slug}.{ROOT_DOMAIN}` is a no — those are Markii's
 * to hand out. But Markii **does** attach and detach tenant subdomains as
 * storefronts are published, renamed, and deleted, so they cannot be covered by
 * the detach guard or that lifecycle would refuse itself.
 *
 * What stays protected is Markii's own routing: the apex, its `www`, the
 * deployment's `*.vercel.app`, and localhost. Detaching one of those would take
 * the whole platform down, and there is no undo.
 */
export function isPlatformCriticalHost(domain: string): boolean {
  const root = normalizeDomain(process.env.ROOT_DOMAIN ?? "");
  return (
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".vercel.app") ||
    (root !== null && (domain === root || domain === `www.${root}`))
  );
}

/**
 * Every record a merchant may need, ownership first — it is the one that gates.
 *
 * `resolvedTargetIps` is what `cnameTarget()` currently resolves to. Callers that
 * have already read DNS should pass it, so the apex instruction names addresses
 * that are live rather than a constant that has drifted. Callers that have not
 * may omit it and get the configured or documented value.
 */
export function dnsRecordsFor(
  domain: string,
  token: string,
  resolvedTargetIps: string[] = [],
): DnsRecord[] {
  const records: DnsRecord[] = [
    {
      type: "TXT",
      name: ownershipRecordName(domain),
      value: ownershipRecordValue(token),
      purpose: "ownership",
    },
  ];

  if (looksLikeApex(domain)) {
    for (const ip of aRecords(resolvedTargetIps)) {
      records.push({ type: "A", name: domain, value: ip, purpose: "pointing" });
    }
  } else {
    records.push({ type: "CNAME", name: domain, value: cnameTarget(), purpose: "pointing" });
  }

  return records;
}

/**
 * Does any observed TXT record carry this token?
 *
 * TXT values arrive as arrays of ≤255-byte chunks that must be concatenated —
 * a resolver splitting a long value is not a mismatch, and comparing chunk by
 * chunk would reject a correctly published record. Compared case-insensitively
 * because some DNS UIs normalise case on the way in.
 */
export function txtCarriesToken(observed: string[][], token: string): boolean {
  const expected = ownershipRecordValue(token).toLowerCase();
  return observed.some((chunks) => chunks.join("").trim().toLowerCase() === expected);
}

/**
 * Does the host point here — by either record? Neither is required to verify.
 *
 * `resolvedTargetIps` are the addresses `cnameTarget()` answers on right now.
 * Accepting them is what stops this check from going stale: Vercel's addresses
 * differ per account and move over time, so a check against a hardcoded IP
 * eventually starts calling correctly pointed apex domains wrong — a false
 * negative on a merchant who did everything right, which is the worst kind.
 *
 * An explicit `SITE_DOMAIN_A_RECORD` still wins, via `aRecords`: a deployment
 * that has stated its addresses means it, and live resolution must not quietly
 * widen what that deployment accepts.
 */
export function pointsHere(
  observed: { cname: string[]; a: string[] },
  resolvedTargetIps: string[] = [],
): boolean {
  const target = cnameTarget();
  const expectedIps = new Set(aRecords(resolvedTargetIps));
  return (
    observed.cname.some((v) => normalizeDomain(v) === target) ||
    observed.a.some((ip) => expectedIps.has(ip))
  );
}
