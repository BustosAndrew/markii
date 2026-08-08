import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../api";
import { emailIdentities } from "../../db";
import { claimDomain, refreshIdentity, releaseDomain } from "../../email/identity";
import { suppress, unsuppress } from "../../email/suppression";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Sending domains and the suppression list (§6).
 *
 * Everything here talks to AWS, which is why almost none of it happens inside
 * the transaction. SES registrations and DNS lookups are not rollbackable, so
 * they run as post-commit effects or — where the result is the whole point of
 * the call, as with claiming a domain — the row is written only after AWS has
 * already agreed. A dry run of these actions performs no AWS call at all, which
 * is the correct behaviour: `dryRun` promises no side effects, and creating an
 * SES identity is a side effect that outlives the transaction.
 */

async function ownedIdentity(ctx: ActionContext, identityId: number) {
  if (!ctx.actor.orgId) throw notFound("Sending domain");
  const [row] = await ctx.db
    .select()
    .from(emailIdentities)
    .where(and(eq(emailIdentities.id, identityId), eq(emailIdentities.orgId, ctx.actor.orgId)))
    .limit(1);
  if (!row) throw notFound("Sending domain");
  return row;
}

export const addSendingDomain = defineAction({
  id: "email.addSendingDomain",
  description:
    "Register a domain to send customer email from, and return the DNS records to publish. " +
    "Customer mail is always sent from the merchant's own domain — Markii never sends it from " +
    "markii.shop, because a merchant's bounces must not land on Markii's sending reputation.",
  input: z
    .object({
      domain: z.string().min(3).max(253),
      /** Mailbox part only. The full sender is `${fromLocalPart}@${domain}`. */
      fromLocalPart: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores")
        .optional(),
      fromName: z.string().max(200).nullish(),
      replyTo: z.string().email().max(320).nullish(),
    })
    .strict(),
  permission: "org.write",
  /**
   * Medium, not low: the domain becomes the From address on every receipt a
   * customer sees, and a wrong one is visible to shoppers rather than staff.
   */
  riskTier: "medium",
  /** D40 step-up: moves money or grants access. */
  requiresStepUp: true,
  undoable: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");

    if (ctx.dryRun) {
      /**
       * Deliberately does not call SES. `dryRun` means "show me what would
       * happen without doing it", and registering an identity with AWS is a
       * durable change that no rollback here can withdraw.
       */
      return {
        wouldRegister: input.domain.trim().toLowerCase(),
        note: "A dry run does not contact AWS, so no DKIM records are generated.",
      };
    }

    const result = await claimDomain({
      orgId: ctx.actor.orgId,
      domain: input.domain,
      ...(input.fromLocalPart ? { fromLocalPart: input.fromLocalPart } : {}),
      fromName: input.fromName ?? null,
      replyTo: input.replyTo ?? null,
    });

    if (!result.ok) {
      if (result.code === "taken") throw conflict(result.message);
      throw badRequest(result.message);
    }

    ctx.recordDiff({
      entity: "emailIdentity",
      entityId: String(result.identity.id),
      path: "domain",
      before: null,
      after: result.identity.domain,
    });

    return {
      identityId: result.identity.id,
      domain: result.identity.domain,
      status: result.identity.status,
      senderAddress: `${result.identity.fromLocalPart}@${result.identity.domain}`,
      /** Publish these, then run `email.verifySendingDomain`. */
      dns: result.identity.dkimTokens.map((token) => ({
        type: "CNAME" as const,
        name: `${token}._domainkey.${result.identity.domain}`,
        value: `${token}.dkim.amazonses.com`,
      })),
      note:
        "Publish these CNAME records, then verify. Until the domain verifies, no customer mail " +
        "is sent — it is not sent from markii.shop in the meantime.",
    };
  },
});

export const verifySendingDomain = defineAction({
  id: "email.verifySendingDomain",
  description:
    "Re-check a sending domain's DKIM records with AWS and update its status. Verification is " +
    "asynchronous on AWS's side, so this is how a merchant finds out DNS has propagated.",
  input: z.object({ identityId: z.number().int().positive() }).strict(),
  permission: "org.write",
  riskTier: "low",
  undoable: false,
  async run(input, ctx) {
    const identity = await ownedIdentity(ctx, input.identityId);
    if (ctx.dryRun) {
      return { identityId: identity.id, status: identity.status, checked: false };
    }

    const result = await refreshIdentity(identity);
    if (!result.ok) {
      return {
        identityId: identity.id,
        status: identity.status,
        checked: false,
        /** Reported, not thrown: AWS being unreachable is not a merchant error. */
        problem: result.message,
      };
    }

    return {
      identityId: result.identity.id,
      domain: result.identity.domain,
      status: result.identity.status,
      checked: true,
      verifiedAt: result.identity.verifiedAt?.toISOString() ?? null,
      problem: result.identity.lastError,
      canSend: result.identity.status === "verified",
    };
  },
});

export const removeSendingDomain = defineAction({
  id: "email.removeSendingDomain",
  description:
    "Remove a sending domain. Customer email stops immediately if this was the verified domain.",
  input: z.object({ identityId: z.number().int().positive() }).strict(),
  permission: "org.write",
  /**
   * High: removing the verified domain silently stops every order confirmation,
   * shipping notice and download email. Nothing errors — customers simply stop
   * hearing from the store.
   */
  riskTier: "high",
  undoable: false,
  async run(input, ctx) {
    const identity = await ownedIdentity(ctx, input.identityId);
    if (ctx.dryRun) {
      return {
        identityId: identity.id,
        domain: identity.domain,
        wouldStopSending: identity.status === "verified",
      };
    }

    await releaseDomain(identity);
    ctx.recordDiff({
      entity: "emailIdentity",
      entityId: String(identity.id),
      path: "domain",
      before: identity.domain,
      after: null,
    });

    return {
      identityId: identity.id,
      domain: identity.domain,
      removed: true,
      sendingStopped: identity.status === "verified",
    };
  },
});

export const suppressAddress = defineAction({
  id: "email.suppressAddress",
  description: "Stop sending customer email to an address.",
  input: z
    .object({
      email: z.string().email().max(320),
      note: z.string().max(500).optional(),
    })
    .strict(),
  permission: "commerce.write",
  riskTier: "low",
  undoable: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;
    if (ctx.dryRun) return { email: input.email.toLowerCase(), suppressed: false };

    await suppress({
      orgId,
      email: input.email,
      reason: "manual",
      detail: input.note ?? null,
    });
    return { email: input.email.toLowerCase(), suppressed: true, reason: "manual" as const };
  },
});

export const unsuppressAddress = defineAction({
  id: "email.unsuppressAddress",
  description:
    "Resume sending to a suppressed address. Addresses that reported mail as spam cannot be " +
    "re-enabled — that consent was withdrawn by the recipient, not by us.",
  input: z.object({ email: z.string().email().max(320) }).strict(),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;
    if (ctx.dryRun) return { email: input.email.toLowerCase(), removed: false };

    const result = await unsuppress(orgId, input.email);
    if (!result.removed && result.reason) {
      /**
       * A complaint refusal is a `conflict`, not a silent no-op: the merchant
       * asked for something and must be told it did not happen, and why.
       */
      throw conflict(result.reason);
    }
    return { email: input.email.toLowerCase(), removed: result.removed };
  },
});
