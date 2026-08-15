import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../api";
import { sites } from "../../db";
import { invalidateCustomDomain } from "../../domains";
import { normalizeDomain } from "../../domains/normalize";
import { dnsRecordsFor } from "../../domains/records";
import { connectDomain, disconnectDomain, verifyDomain } from "../../domains/verification";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Custom storefront domains (§2).
 *
 * These used to be a field on `PATCH /api/sites/:id`, which meant any role with
 * `cms.write` could write any hostname into the routing table with no proof of
 * ownership — including one belonging to somebody else. The routes now refuse
 * `customDomain` by name (`SITE_FIELDS_ELSEWHERE`) and it moves only through
 * here, which is also what puts it behind one permission check for the UI, the
 * HTTP API, agents, and MCP at once (§22 rule 1).
 *
 * **DNS reads happen on dry runs; DNS writes never do** — there are none. Every
 * database write goes through `ctx.db`, so a dry run rolls back cleanly, and the
 * only thing a merchant is asked to change lives in their own zone file.
 */

async function ownedSite(ctx: ActionContext, siteId: number) {
  if (!ctx.actor.orgId) throw notFound("Site");
  const [row] = await ctx.db
    .select()
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, ctx.actor.orgId)))
    .limit(1);
  // 404 rather than 403 for another org's site: a 403 confirms the id exists.
  if (!row) throw notFound("Site");
  return row;
}

export const connectCustomDomain = defineAction({
  id: "domains.connect",
  description:
    "Connect a custom domain to a storefront and return the DNS records to publish. The domain " +
    "does not serve traffic until it is verified — publishing the TXT record is how the merchant " +
    "proves they control it.",
  input: z
    .object({
      siteId: z.number().int().positive(),
      domain: z.string().min(3).max(253),
    })
    .strict(),
  permission: "cms.write",
  /**
   * Medium, not high: connecting is inert. The claim routes nothing until DNS
   * proves ownership, and a wrong hostname here costs a merchant a re-typed
   * field rather than a live storefront.
   */
  riskTier: "medium",
  undoable: true,
  async run(input, ctx) {
    const site = await ownedSite(ctx, input.siteId);

    if (ctx.dryRun) {
      const domain = normalizeDomain(input.domain);
      if (!domain) throw badRequest("That does not look like a domain.");
      return {
        siteId: site.id,
        wouldConnect: domain,
        currentDomain: site.customDomain,
        /** Shown so a proposal can be read before the token exists. */
        records: dnsRecordsFor(domain, "«token issued when you connect»"),
      };
    }

    const result = await connectDomain({ site, domain: input.domain }, ctx.db);
    if (!result.ok) {
      if (result.code === "taken") throw conflict(result.message);
      throw badRequest(result.message);
    }

    ctx.recordDiff({
      entity: "site",
      entityId: String(site.id),
      path: "customDomain",
      before: site.customDomain,
      after: result.site.customDomain,
    });

    // The old host must stop resolving as surely as the new one starts, and the
    // new one was very likely cached as a negative result while it was unconnected.
    ctx.effect("invalidate custom-domain cache", async () => {
      invalidateCustomDomain(site.customDomain, result.site.customDomain);
    });

    return {
      siteId: site.id,
      domain: result.site.customDomain,
      status: result.site.domainStatus,
      alreadyVerified: result.unchanged,
      records: result.records,
      note: result.unchanged
        ? "This domain is already verified for this storefront. Nothing changed."
        : "Publish these records, then run domains.verify. Until it verifies, the domain does " +
          "not serve this storefront.",
    };
  },
});

export const verifyCustomDomain = defineAction({
  id: "domains.verify",
  description:
    "Re-read a custom domain's DNS and update its status. Verification is the merchant's DNS " +
    "propagating, so this is a pull — nothing here polls on their behalf.",
  input: z.object({ siteId: z.number().int().positive() }).strict(),
  permission: "cms.write",
  riskTier: "low",
  undoable: false,
  async run(input, ctx) {
    const site = await ownedSite(ctx, input.siteId);
    if (!site.customDomain) {
      throw badRequest("No custom domain is connected to this storefront.");
    }

    /**
     * A dry run still reads DNS. Reads are what `dryRun` permits — it promises no
     * *side effects*, and a resolver query leaves nothing behind. Refusing to
     * look would make the proposal useless: the whole answer is what DNS says.
     */
    const result = await verifyDomain(site, ctx.db);

    if (result.verified && site.domainStatus !== "verified") {
      ctx.recordDiff({
        entity: "site",
        entityId: String(site.id),
        path: "domainStatus",
        before: site.domainStatus,
        after: "verified",
      });
      ctx.effect("invalidate custom-domain cache", async () => {
        invalidateCustomDomain(result.site.customDomain);
      });
    }

    return {
      siteId: site.id,
      domain: result.site.customDomain,
      status: result.site.domainStatus,
      verified: result.verified,
      /** False means DNS could not be read — not that the record is missing. */
      checked: result.checked,
      /**
       * Verified and pointing are separate facts. A domain can be proved and
       * still not send traffic here, and saying "verified" alone would imply a
       * storefront is reachable when it is not.
       */
      pointsToMarkii: result.pointsToMarkii,
      verifiedAt: result.site.domainVerifiedAt?.toISOString() ?? null,
      problem: result.problem,
      records: result.records,
    };
  },
});

export const disconnectCustomDomain = defineAction({
  id: "domains.disconnect",
  description:
    "Remove a custom domain from a storefront. The storefront stays reachable on its Markii " +
    "subdomain; every link and bookmark on the custom domain stops working.",
  input: z.object({ siteId: z.number().int().positive() }).strict(),
  permission: "cms.write",
  /**
   * High: this is a publishing change with no error to warn anyone. Traffic to
   * the domain simply stops arriving, and every inbound link, search result, and
   * agent citation pointing at it breaks at once.
   */
  riskTier: "high",
  undoable: false,
  async run(input, ctx) {
    const site = await ownedSite(ctx, input.siteId);
    if (!site.customDomain) {
      throw badRequest("No custom domain is connected to this storefront.");
    }

    if (ctx.dryRun) {
      return {
        siteId: site.id,
        domain: site.customDomain,
        wouldStopServing: site.domainStatus === "verified",
      };
    }

    const row = await disconnectDomain(site, ctx.db);
    ctx.recordDiff({
      entity: "site",
      entityId: String(site.id),
      path: "customDomain",
      before: site.customDomain,
      after: null,
    });
    ctx.effect("invalidate custom-domain cache", async () => {
      invalidateCustomDomain(site.customDomain);
    });

    return {
      siteId: row.id,
      domain: site.customDomain,
      removed: true,
      /** True when this was actually serving traffic — the case worth confirming. */
      stoppedServing: site.domainStatus === "verified",
    };
  },
});
