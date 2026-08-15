import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { platformStatus } from "@/lib/domains/platform";
import { cnameTarget, dnsRecordsFor, pointsHere } from "@/lib/domains/records";
import { observeDns } from "@/lib/domains/verification";
import { resolveSite } from "@/lib/queries";

/**
 * `GET /api/sites/:idOrSlug/domain` (§2) — custom domain status and its DNS.
 *
 * Mutations are actions (§22 rule 1): `domains.connect`, `domains.verify`,
 * `domains.disconnect`.
 *
 * **Two facts are reported separately and never merged into "domain: OK".**
 * Ownership (the TXT record) is what Markii gates routing on; pointing (the
 * CNAME or A record) is what actually delivers traffic. A merchant who has done
 * one and not the other needs to be told which, and a single green tick would
 * tell them neither.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);

    if (!site.customDomain || !site.domainVerificationToken) {
      return NextResponse.json({
        siteId: site.id,
        domain: null,
        status: "none" as const,
        verifiedAt: null,
        checkedAt: null,
        problem: null,
        records: [],
        pointsToMarkii: false,
        platform: null,
        /** So a screen can show the target before a domain is even typed. */
        expectedTarget: cnameTarget(),
      });
    }

    /**
     * DNS is read live rather than served from `domain_checked_at`. The stored
     * value is whatever the last explicit check found, and between checks it
     * ages into a claim about the present that nobody re-tested — exactly the
     * kind of surface that reports success after the underlying fact changed.
     * One resolver round trip on a settings screen is a fair price.
     */
    /**
     * Both live reads, in parallel — they are independent, and doing them in
     * series would double the wait on a settings screen for no gain.
     *
     * The platform is only asked about a **verified** domain, because that is
     * the only state in which Markii ever registers one. Asking about a pending
     * claim would reliably answer "not registered" and read as a failure, when
     * it is the correct and expected state.
     */
    const [observed, platform] = await Promise.all([
      observeDns(site.customDomain),
      site.domainStatus === "verified"
        ? platformStatus(site.customDomain)
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      siteId: site.id,
      domain: site.customDomain,
      status: site.domainStatus,
      verifiedAt: site.domainVerifiedAt?.toISOString() ?? null,
      checkedAt: site.domainCheckedAt?.toISOString() ?? null,
      problem: site.domainLastError,
      /** Derived from the current token, never a stored copy of the instructions. */
      records: dnsRecordsFor(site.customDomain, site.domainVerificationToken),
      /**
       * Verified but not pointed is a real state, and a common one — the
       * merchant proved ownership and has not moved traffic over yet. Saying
       * only "verified" would imply the storefront answers there, and it does not.
       */
      pointsToMarkii: pointsHere({ cname: observed.cname, a: observed.a }),
      /** Null unless DNS itself was unreachable. An absent record is not an error. */
      lookupProblem: observed.problem,
      /**
       * **The third fact, and the one that actually decides reachability.**
       * Ownership makes Markii willing to route the host and pointing sends
       * traffic to Vercel's edge — but Vercel drops a hostname that is not
       * registered to this project before `proxy.ts` runs, and issues no
       * certificate for it. Null while the domain is unverified, because Markii
       * does not register one until ownership is proved.
       */
      platform,
      expectedTarget: cnameTarget(),
    });
  },
  { permission: "cms.read" },
);
