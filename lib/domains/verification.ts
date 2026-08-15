import "server-only";

import { Resolver } from "node:dns/promises";
import { and, eq, ne } from "drizzle-orm";
import { db, sites, type DbHandle, type Site } from "../db";
import { normalizeDomain } from "./normalize";
import {
  dnsRecordsFor,
  generateVerificationToken,
  isReservedHost,
  ownershipRecordName,
  pointsHere,
  txtCarriesToken,
  type DnsRecord,
} from "./records";

/**
 * Custom storefront domain verification (§2).
 *
 * A merchant proves control of a hostname by publishing a TXT nonce; until they
 * do, `resolveCustomDomain` will not route it. That ordering is the whole point.
 * Before migration 0031 `custom_domain` was free text any `cms.write` role could
 * set, so an org could claim a hostname it did not own and answer for it the
 * moment DNS pointed here.
 *
 * **Pull, not push.** Nothing in this deployment schedules jobs (`CLAUDE.md`), so
 * a merchant pressing "check" is what advances a claim. There is no background
 * sweep re-checking verified domains either, which is deliberate: a domain that
 * stops resolving for an hour must not quietly un-verify and take a live
 * storefront offline.
 */

/**
 * DNS is on a merchant-facing request path, and the default resolver will sit
 * through a full retry schedule on an unreachable nameserver. Three seconds and
 * two tries is enough for a healthy lookup and short enough that "check again"
 * comes back while the merchant is still looking at it.
 */
function resolver(): Resolver {
  return new Resolver({ timeout: 3_000, tries: 2 });
}

/**
 * A DNS name that does not exist yet is the *expected* state of a domain a
 * merchant just claimed — it is not an error, and reporting it as one would make
 * every first check look broken.
 */
const ABSENT = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

function isAbsent(e: unknown): boolean {
  return typeof e === "object" && e !== null && ABSENT.has(String((e as { code?: string }).code));
}

export type DnsObservation = {
  txt: string[][];
  cname: string[];
  a: string[];
  /** Set only when DNS itself failed — never when a record is merely absent. */
  problem: string | null;
};

/**
 * Read everything the verification decision needs, in one pass.
 *
 * Each lookup is independent: a missing CNAME must not stop the TXT record from
 * being read, or a merchant who has published ownership but not yet pointed the
 * domain would never verify.
 */
export async function observeDns(domain: string): Promise<DnsObservation> {
  const r = resolver();
  const problems: string[] = [];

  async function attempt<T>(label: string, fn: () => Promise<T>, empty: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isAbsent(e)) return empty;
      problems.push(`${label} lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      return empty;
    }
  }

  const [txt, cname, a] = await Promise.all([
    attempt("TXT", () => r.resolveTxt(ownershipRecordName(domain)), [] as string[][]),
    attempt("CNAME", () => r.resolveCname(domain), [] as string[]),
    attempt("A", () => r.resolve4(domain), [] as string[]),
  ]);

  return { txt, cname, a, problem: problems.length > 0 ? problems.join("; ") : null };
}

export type ConnectResult =
  | { ok: true; site: Site; records: DnsRecord[]; unchanged: boolean }
  | { ok: false; code: "invalid_domain" | "taken" | "reserved"; message: string };

/**
 * Claim a hostname for a site and hand back the records to publish.
 *
 * Connecting is not routing: the row lands as `pending` and stays inert until
 * `verifyDomain` finds the TXT record. A **verified** claim elsewhere blocks
 * this; a pending one does not, so a squatter cannot park a claim to lock the
 * real owner out. Only proof is exclusive.
 */
export async function connectDomain(
  input: { site: Site; domain: string },
  handle: DbHandle = db,
): Promise<ConnectResult> {
  const domain = normalizeDomain(input.domain);
  if (!domain) {
    return {
      ok: false,
      code: "invalid_domain",
      message: "That does not look like a domain. Use the bare hostname, for example `shop.acme.com`.",
    };
  }

  if (isReservedHost(domain)) {
    return {
      ok: false,
      code: "reserved",
      message: `${domain} is a Markii hostname and cannot be connected as a custom domain.`,
    };
  }

  // Already connected and proved on this site: return it untouched. Re-issuing a
  // token here would set a live storefront back to `pending` and stop routing it.
  if (input.site.customDomain === domain && input.site.domainStatus === "verified") {
    return {
      ok: true,
      site: input.site,
      records: dnsRecordsFor(domain, input.site.domainVerificationToken ?? ""),
      unchanged: true,
    };
  }

  const [heldElsewhere] = await handle
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(
        eq(sites.customDomain, domain),
        eq(sites.domainStatus, "verified"),
        ne(sites.id, input.site.id),
      ),
    )
    .limit(1);
  if (heldElsewhere) {
    return {
      ok: false,
      code: "taken",
      // Deliberately does not say which site or which org holds it: who else
      // sells from a given domain is not this caller's business to learn.
      message: `${domain} has already been verified by another Markii storefront.`,
    };
  }

  const token = generateVerificationToken();
  const [row] = await handle
    .update(sites)
    .set({
      customDomain: domain,
      domainStatus: "pending",
      domainVerificationToken: token,
      domainVerifiedAt: null,
      domainCheckedAt: null,
      domainLastError: null,
      updatedAt: new Date(),
    })
    .where(eq(sites.id, input.site.id))
    .returning();

  return { ok: true, site: row, records: dnsRecordsFor(domain, token), unchanged: false };
}

export type VerifyResult = {
  site: Site;
  verified: boolean;
  /** False when DNS could not be read at all — distinct from "read it, not there". */
  checked: boolean;
  pointsToMarkii: boolean;
  problem: string | null;
  records: DnsRecord[];
};

/** Postgres unique violation — here, the partial index on verified domains. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/**
 * Re-read DNS and record what it says.
 *
 * A failure to reach DNS is **reported, never applied**: a resolver blip is not
 * evidence that a verified domain stopped being owned, and downgrading on it
 * would take a live storefront offline over a network hiccup. For the same
 * reason nothing here ever moves a domain from `verified` back to `pending`.
 */
export async function verifyDomain(site: Site, handle: DbHandle = db): Promise<VerifyResult> {
  const domain = site.customDomain;
  if (!domain || site.domainStatus === "none") {
    return {
      site,
      verified: false,
      checked: false,
      pointsToMarkii: false,
      problem: "No custom domain is connected to this site.",
      records: [],
    };
  }

  // A row grandfathered by migration 0031, or one written before tokens existed,
  // has nothing to check against. Issue one rather than failing: the merchant
  // gets a record to publish instead of an error they cannot act on.
  let token = site.domainVerificationToken;
  if (!token) {
    token = generateVerificationToken();
    const [row] = await handle
      .update(sites)
      .set({ domainVerificationToken: token })
      .where(eq(sites.id, site.id))
      .returning();
    site = row;
  }

  const records = dnsRecordsFor(domain, token);
  const observed = await observeDns(domain);
  const pointing = pointsHere({ cname: observed.cname, a: observed.a });
  const carries = txtCarriesToken(observed.txt, token);

  if (!carries) {
    const problem = observed.problem
      ? `DNS could not be read: ${observed.problem}`
      : observed.txt.length === 0
        ? `No TXT record found at ${ownershipRecordName(domain)}. New records can take up to an hour to propagate.`
        : `A TXT record exists at ${ownershipRecordName(domain)} but does not carry this site's token.`;

    const [row] = await handle
      .update(sites)
      .set({
        domainCheckedAt: new Date(),
        domainLastError: problem,
        // Status is untouched. A verified domain stays verified; a pending one
        // stays pending. Nothing here is evidence of a change in ownership.
      })
      .where(eq(sites.id, site.id))
      .returning();

    return {
      site: row,
      verified: row.domainStatus === "verified",
      checked: observed.problem === null,
      pointsToMarkii: pointing,
      problem,
      records,
    };
  }

  try {
    const [row] = await handle
      .update(sites)
      .set({
        domainStatus: "verified",
        domainVerifiedAt: site.domainVerifiedAt ?? new Date(),
        domainCheckedAt: new Date(),
        domainLastError: null,
        updatedAt: new Date(),
      })
      .where(eq(sites.id, site.id))
      .returning();

    return {
      site: row,
      verified: true,
      checked: true,
      pointsToMarkii: pointing,
      /**
       * Owned but not yet pointed is a real, common, and temporary state. It is
       * reported so the dashboard can say "verified — DNS is not pointing here
       * yet" instead of showing a storefront URL that does not answer.
       */
      problem: pointing
        ? null
        : `${domain} is verified, but its DNS does not point to Markii yet, so the storefront will not answer there.`,
      records,
    };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Lost a race, or the domain was verified elsewhere between the ownership
    // check and this write. The index is what makes that impossible to miss.
    const problem = `${domain} has already been verified by another Markii storefront.`;
    const [row] = await handle
      .update(sites)
      .set({ domainCheckedAt: new Date(), domainLastError: problem })
      .where(eq(sites.id, site.id))
      .returning();
    return {
      site: row,
      verified: false,
      checked: true,
      pointsToMarkii: pointing,
      problem,
      records,
    };
  }
}

/** Release the domain. The site keeps serving on its `{slug}.{ROOT_DOMAIN}` host. */
export async function disconnectDomain(site: Site, handle: DbHandle = db): Promise<Site> {
  const [row] = await handle
    .update(sites)
    .set({
      customDomain: null,
      domainStatus: "none",
      domainVerificationToken: null,
      domainVerifiedAt: null,
      domainCheckedAt: null,
      domainLastError: null,
      updatedAt: new Date(),
    })
    .where(eq(sites.id, site.id))
    .returning();
  return row;
}
