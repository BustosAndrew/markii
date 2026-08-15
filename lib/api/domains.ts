import { invokeAction } from "./actions";
import { apiGet } from "./client";
import { callWhenLive } from "./planned";
import type { DomainStatus } from "./types";

const DOMAINS_SECTION = "API §2 (custom domains)";

/**
 * ✅ LIVE — `GET /api/sites/:idOrSlug/domain` and the three `domains.*` actions.
 *
 * No credential gates this. Verification is a DNS lookup from the server and the
 * merchant's own zone file; there is nothing to configure on the deployment
 * beyond `SITE_DOMAIN_CNAME_TARGET` / `SITE_DOMAIN_A_RECORD`, which have working
 * defaults for this host and only change what the merchant is told to publish.
 */
const DOMAINS_API_LIVE = true;

export type DomainRecord = {
  type: "TXT" | "CNAME" | "A";
  name: string;
  value: string;
  /**
   * Which question the record answers. Show both, and never collapse them:
   * `ownership` is what Markii gates routing on, `pointing` is what actually
   * delivers traffic. A merchant who has done one and not the other needs to
   * know which one is missing.
   */
  purpose: "ownership" | "pointing";
};

/**
 * Whether the hosting platform will actually accept traffic for the hostname.
 *
 * **This is the fact that decides reachability, and it is separate from both
 * others.** Ownership makes Markii willing to route the host; pointing sends
 * traffic to Vercel's edge; but Vercel drops a hostname not registered to this
 * project *before* the app runs, and issues no TLS certificate for it. A domain
 * can be verified, pointing correctly, and still serve nothing.
 *
 * `configured: false` means Markii has no platform credentials — **the
 * merchant can do nothing about it**, so never phrase it as their problem.
 */
export type PlatformStatus = {
  configured: boolean;
  /** Null when unknown — unconfigured, or the platform was unreachable. */
  registered: boolean | null;
  /** Vercel's own view of the DNS. May lag `pointsToMarkii` while records propagate. */
  misconfigured: boolean | null;
  problem: string | null;
};

export type SiteDomain = {
  siteId: number;
  domain: string | null;
  status: DomainStatus;
  verifiedAt: string | null;
  checkedAt: string | null;
  /** Why the last check did not verify, phrased for a merchant. */
  problem: string | null;
  records: DomainRecord[];
  /**
   * Read live on every call. `true` with `status: "verified"` is the only
   * combination that means the storefront actually answers on this hostname.
   */
  pointsToMarkii: boolean;
  /** Set only when DNS itself was unreachable — an absent record is not this. */
  lookupProblem?: string | null;
  /**
   * Null until the domain is verified — Markii does not register a hostname
   * with the platform before ownership is proved, so "not registered" on a
   * pending claim would read as a failure when it is the correct state.
   */
  platform: PlatformStatus | null;
  /** The CNAME target for this deployment, so a screen can show it up front. */
  expectedTarget: string;
};

export function getSiteDomain(idOrSlug: string, init?: RequestInit) {
  return callWhenLive(DOMAINS_API_LIVE, DOMAINS_SECTION, () =>
    apiGet<SiteDomain>(`/api/sites/${encodeURIComponent(idOrSlug)}/domain`, undefined, init),
  );
}

/** One storefront's row in the org-wide overview. */
export type OrgDomainRow = {
  siteId: number;
  siteName: string;
  siteSlug: string;
  /** Verified-only, like `Site.storefrontUrl` — never the unverified claim. */
  storefrontUrl: string;
  domain: string | null;
  status: DomainStatus;
  verifiedAt: string | null;
  /** Null means never checked — different from checked and still failing. */
  checkedAt: string | null;
  problem: string | null;
};

export type OrgDomains = {
  items: OrgDomainRow[];
  counts: { verified: number; pending: number; none: number };
  expectedTarget: string;
  /**
   * Always `false` on this endpoint, and it is here so a screen cannot infer
   * freshness from the absence of a problem.
   */
  dnsCheckedLive: boolean;
};

/**
 * Every storefront's domain in one call.
 *
 * **No DNS is read here** — that is the point of the endpoint. A loop over
 * `getSiteDomain` would be one resolver round trip per store on a single page
 * load, each able to time out on its own.
 *
 * So **`pointsToMarkii` is absent, not false.** It is a live fact and this
 * response carries none; rendering a stale "not pointing" would send a merchant
 * off to break DNS that works. Link to the site's own page for a fresh answer.
 */
export function getOrgDomains(init?: RequestInit) {
  return callWhenLive(DOMAINS_API_LIVE, DOMAINS_SECTION, () =>
    apiGet<OrgDomains>("/api/settings/domains", undefined, init),
  );
}

/**
 * Claim a hostname and get the records to publish.
 *
 * **Connecting is not connecting traffic.** The domain lands as `pending` and
 * routes nothing until `verifyDomain` finds the TXT record — so do not show a
 * success state that implies the storefront is reachable there yet.
 *
 * `409` means another Markii storefront has already *verified* that hostname.
 * A pending claim elsewhere is not a conflict: several merchants may be mid-setup
 * on the same domain, and only proof is exclusive.
 */
export function connectDomain(body: { siteId: number; domain: string }, init?: RequestInit) {
  return invokeAction<{
    siteId: number;
    domain: string | null;
    status: DomainStatus;
    /** True when the domain was already verified here and nothing changed. */
    alreadyVerified: boolean;
    records: DomainRecord[];
    note: string;
  }>("domains.connect", body, init);
}

/**
 * Re-read DNS. **Pull, not push** — nothing here polls on the merchant's behalf,
 * so this button is what advances a claim.
 *
 * `checked: false` means DNS could not be read at all, which is reported rather
 * than thrown and never downgrades an already-verified domain. A missing record
 * is the ordinary first answer, not a failure: propagation can take an hour.
 */
export function verifyDomain(body: { siteId: number }, init?: RequestInit) {
  return invokeAction<{
    siteId: number;
    domain: string | null;
    status: DomainStatus;
    verified: boolean;
    checked: boolean;
    pointsToMarkii: boolean;
    verifiedAt: string | null;
    problem: string | null;
    records: DomainRecord[];
    /**
     * **`"queued"` means attempted, not done.** Attaching the hostname to the
     * hosting platform runs after the transaction commits, so this response
     * cannot know the outcome. Re-read `getSiteDomain` for what the platform
     * actually says, and never render `"queued"` as success.
     */
    platformRegistration: "queued" | "configuration_required" | "not_applicable";
  }>("domains.verify", body, init);
}

/**
 * High risk, and the reason is not visible on the button: nothing errors, traffic
 * to the domain simply stops arriving, and every inbound link, search result, and
 * agent citation pointing at it breaks at once. Confirm before the call — use
 * `stoppedServing` to tell a live removal from an abandoned claim.
 */
export function disconnectDomain(body: { siteId: number }, init?: RequestInit) {
  return invokeAction<{
    siteId: number;
    domain: string;
    removed: true;
    stoppedServing: boolean;
  }>("domains.disconnect", body, init);
}
