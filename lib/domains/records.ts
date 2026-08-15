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

export function aRecords(): string[] {
  const configured = (process.env.SITE_DOMAIN_A_RECORD ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [DEFAULT_A_RECORD];
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

/** Every record a merchant may need, ownership first — it is the one that gates. */
export function dnsRecordsFor(domain: string, token: string): DnsRecord[] {
  const records: DnsRecord[] = [
    {
      type: "TXT",
      name: ownershipRecordName(domain),
      value: ownershipRecordValue(token),
      purpose: "ownership",
    },
  ];

  if (looksLikeApex(domain)) {
    for (const ip of aRecords()) {
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

/** Does the host point here — by either record? Neither is required to verify. */
export function pointsHere(observed: { cname: string[]; a: string[] }): boolean {
  const target = cnameTarget();
  const expectedIps = new Set(aRecords());
  return (
    observed.cname.some((v) => normalizeDomain(v) === target) ||
    observed.a.some((ip) => expectedIps.has(ip))
  );
}
