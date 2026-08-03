import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { emailStatus, isSesConfigured, merchantEmailStatus } from "@/lib/email";
import { dnsRecords, listIdentities } from "@/lib/email/identity";
import { listSuppressions } from "@/lib/email/suppression";

/**
 * `GET /api/settings/email` (§6) — sending domains, deliverability, suppressions.
 *
 * Mutations are actions (§22 rule 1): `email.addSendingDomain`,
 * `email.verifySendingDomain`, `email.removeSendingDomain`,
 * `email.suppressAddress`, `email.unsuppressAddress`.
 *
 * **The two email streams are reported separately and never merged into one
 * "email: OK".** Resend carries Markii's own mail from `markii.shop`; SES
 * carries the merchant's, from their domain. A merchant whose password-reset
 * arrived fine would otherwise reasonably conclude their order confirmations
 * work, and they do not — those need a verified domain of their own (G1).
 */
export const GET = orgHandler(
  async (_req, { orgId }) => {
    const identities = await listIdentities(orgId);
    const [merchant, suppressions] = await Promise.all([
      merchantEmailStatus(orgId),
      listSuppressions(orgId),
    ]);

    const platform = emailStatus();

    return NextResponse.json({
      /** Can this store email its customers right now, and if not, whose job is it? */
      customerEmail: merchant,

      domains: identities.map((identity) => ({
        id: identity.id,
        domain: identity.domain,
        senderAddress: `${identity.fromLocalPart}@${identity.domain}`,
        fromName: identity.fromName,
        replyTo: identity.replyTo,
        status: identity.status,
        verifiedAt: identity.verifiedAt?.toISOString() ?? null,
        lastCheckedAt: identity.lastCheckedAt?.toISOString() ?? null,
        problem: identity.lastError,
        /** Derived from the tokens SES currently expects, never a stored copy. */
        dns: dnsRecords(identity),
      })),

      suppressions: suppressions.map((s) => ({
        email: s.email,
        reason: s.reason,
        detail: s.detail,
        createdAt: s.createdAt.toISOString(),
        /**
         * Surfaced so the UI does not offer a button that will be refused. A
         * complaint is the recipient's decision and the merchant cannot undo it.
         */
        removable: s.reason !== "complaint",
      })),

      /**
       * Platform mail is Markii's own — staff sign-in, invoices, notices. Shown
       * because a merchant debugging "no email" needs to know which stream is
       * broken, not that "email" is.
       */
      platformEmail: {
        status: platform.platform,
        scope: "Markii's own mail to you — sign-in, invoices, platform notices.",
      },

      /**
       * When this is `false` nothing above can work regardless of what the
       * merchant does, and saying so is the difference between a task they can
       * complete and one they cannot.
       */
      providerConfigured: isSesConfigured(),
    });
  },
  { permission: "org.read" },
);
