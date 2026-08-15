import "server-only";

import { and, eq } from "drizzle-orm";
import { db, emailIdentities, organizations, type DbHandle, type EmailIdentity } from "../db";
import { normalizeDomain } from "../domains/normalize";
import { createSesIdentity, deleteSesIdentity, getSesIdentity, isSesConfigured } from "./ses";

/**
 * Merchant sending identities (§6).
 *
 * **A verified domain is a launch blocker, not a setting.** `sendMerchantMail`
 * refuses without one, and that refusal is the mechanism that keeps merchant
 * mail off Markii's sending reputation (G1). Everything here exists to get a
 * merchant from "no identity" to "verified" without ever making the unverified
 * state look like it works.
 */

/** SES DKIM statuses mapped onto the four states we store. */
function statusFromDkim(dkim: string, verifiedForSending: boolean): EmailIdentity["status"] {
  if (verifiedForSending && dkim === "SUCCESS") return "verified";
  if (dkim === "FAILED") return "failed";
  if (dkim === "TEMPORARY_FAILURE") return "temporary_failure";
  return "pending";
}

/**
 * Reduce user input to a bare domain.
 *
 * Merchants paste `https://www.acme.com/`, `Acme.com.`, and `orders@acme.com`.
 * Each of those is a different SES identity or an outright rejection, and the
 * failure arrives minutes later as an unexplained verification that never
 * completes — so normalise before anything touches AWS.
 *
 * Shared with custom storefront domains (`lib/domains/normalize.ts`) rather than
 * copied: the accepted shape mirrors a CHECK constraint in both tables, and two
 * copies would drift into a domain that verifies for mail but not for routing.
 */
export { normalizeDomain };

export type ResolvedSender = {
  address: string;
  name: string | null;
  replyTo: string | null;
  identity: EmailIdentity;
};

/**
 * The verified sender for an org, or null.
 *
 * Only `verified` rows qualify. A `pending` identity would send unauthenticated
 * mail from a domain the merchant has not yet proved they control, which is
 * both a deliverability problem and, if the domain is not theirs, a real one.
 */
export async function resolveSender(
  orgId: string,
  handle: DbHandle = db,
): Promise<ResolvedSender | null> {
  const [identity] = await handle
    .select()
    .from(emailIdentities)
    .where(and(eq(emailIdentities.orgId, orgId), eq(emailIdentities.status, "verified")))
    .limit(1);
  if (!identity) return null;

  let name = identity.fromName;
  if (!name) {
    const [org] = await handle
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    name = org?.name ?? null;
  }

  return {
    address: `${identity.fromLocalPart}@${identity.domain}`,
    name,
    replyTo: identity.replyTo,
    identity,
  };
}

/** Every identity an org has claimed, verified or not, for the settings screen. */
export async function listIdentities(orgId: string): Promise<EmailIdentity[]> {
  return db.select().from(emailIdentities).where(eq(emailIdentities.orgId, orgId));
}

/**
 * The DNS a merchant has to publish. Derived, never stored — SES's CNAME shape
 * is fixed, and a stored copy would be a second thing to keep in sync.
 */
export function dnsRecords(identity: EmailIdentity): {
  type: "CNAME";
  name: string;
  value: string;
}[] {
  return identity.dkimTokens.map((token) => ({
    type: "CNAME" as const,
    name: `${token}._domainkey.${identity.domain}`,
    value: `${token}.dkim.amazonses.com`,
  }));
}

export type ClaimResult =
  | { ok: true; identity: EmailIdentity }
  | { ok: false; code: "invalid_domain" | "taken" | "configuration_required" | "provider_error"; message: string };

/**
 * Claim a domain for an org and register it with SES.
 *
 * The row is written **after** SES accepts, not before. A row without DKIM
 * tokens is an identity a merchant cannot act on: the settings screen would
 * show them a verification step with no records to publish.
 */
export async function claimDomain(input: {
  orgId: string;
  domain: string;
  fromLocalPart?: string;
  fromName?: string | null;
  replyTo?: string | null;
}): Promise<ClaimResult> {
  const domain = normalizeDomain(input.domain);
  if (!domain) {
    return {
      ok: false,
      code: "invalid_domain",
      message: "That does not look like a domain. Use the bare domain, for example `acme.com`.",
    };
  }

  const [existing] = await db
    .select()
    .from(emailIdentities)
    .where(eq(emailIdentities.domain, domain))
    .limit(1);
  if (existing) {
    if (existing.orgId === input.orgId) return { ok: true, identity: existing };
    return {
      ok: false,
      code: "taken",
      // Deliberately does not name the other organization: which competitor
      // sells from a given domain is not this caller's business to learn.
      message: `${domain} is already registered for sending by another Markii account.`,
    };
  }

  if (!isSesConfigured()) {
    return {
      ok: false,
      code: "configuration_required",
      message:
        "Sending domains cannot be verified — AWS SES is not configured on this deployment " +
        "(docs/BACKEND.md §6).",
    };
  }

  const created = await createSesIdentity(domain);
  if (!created.ok) {
    return { ok: false, code: "provider_error", message: created.reason };
  }

  const [identity] = await db
    .insert(emailIdentities)
    .values({
      orgId: input.orgId,
      domain,
      fromLocalPart: (input.fromLocalPart ?? "orders").toLowerCase(),
      fromName: input.fromName ?? null,
      replyTo: input.replyTo ?? null,
      status: "pending",
      dkimTokens: created.tokens,
    })
    .returning();

  return { ok: true, identity };
}

/**
 * Re-read verification from SES and store what it says.
 *
 * Pull, not push: SES verifies asynchronously once DNS propagates, and nothing
 * in this deployment schedules jobs. A merchant pressing "check" is a real
 * trigger; a cached `pending` that never updates is not.
 */
export async function refreshIdentity(
  identity: EmailIdentity,
): Promise<{ ok: true; identity: EmailIdentity } | { ok: false; message: string }> {
  if (!isSesConfigured()) {
    return { ok: false, message: "AWS SES is not configured on this deployment." };
  }

  const res = await getSesIdentity(identity.domain);
  if (!res.ok) {
    // The failure is recorded but the status is left alone: a network blip
    // talking to SES is not evidence that a verified domain stopped working.
    await db
      .update(emailIdentities)
      .set({ lastError: res.reason, lastCheckedAt: new Date() })
      .where(eq(emailIdentities.id, identity.id));
    return { ok: false, message: res.reason };
  }

  const status = statusFromDkim(res.state.dkimStatus, res.state.verifiedForSending);
  const [updated] = await db
    .update(emailIdentities)
    .set({
      status,
      // SES rotates tokens on re-registration; the merchant's DNS must match
      // what SES currently expects, not what it expected at claim time.
      dkimTokens: res.state.tokens.length > 0 ? res.state.tokens : identity.dkimTokens,
      verifiedAt: status === "verified" ? (identity.verifiedAt ?? new Date()) : null,
      lastError: status === "failed" ? "SES could not verify the DKIM records." : null,
      lastCheckedAt: new Date(),
    })
    .where(eq(emailIdentities.id, identity.id))
    .returning();

  return { ok: true, identity: updated };
}

/** Release a domain. Removed from SES first, so a re-claim elsewhere can succeed. */
export async function releaseDomain(identity: EmailIdentity): Promise<void> {
  if (isSesConfigured()) await deleteSesIdentity(identity.domain);
  await db.delete(emailIdentities).where(eq(emailIdentities.id, identity.id));
}
