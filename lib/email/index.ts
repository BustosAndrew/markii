import "server-only";

import { db, emailDeliveries } from "../db";
import { resolveSender, tenantFallbackSender } from "./identity";
import { isResendConfigured, sendViaResend } from "./resend";
import { isSesConfigured, sendViaSes } from "./ses";
import { normalizeEmail, suppressionFor } from "./suppression";
import type { MailInput, MerchantMailInput, SendResult } from "./types";

export type { MailInput, MerchantMailInput, SendResult } from "./types";
export { isResendConfigured } from "./resend";
export { isSesConfigured } from "./ses";

/**
 * Markii's **own** mail, from `markii.shop` via Resend: contact form, support,
 * staff auth, invoices, dunning, platform notices.
 *
 * Never use this for anything a merchant is sending. A merchant's order
 * confirmation going out from `markii.shop` puts their bounces on Markii's
 * sending reputation, which is the failure the two-stream split exists to
 * prevent (G1).
 */
export function sendPlatformMail(input: MailInput): Promise<SendResult> {
  return sendViaResend(input);
}

/**
 * Mail sent **on a merchant's behalf**, from their own verified domain via SES.
 *
 * Four things happen in order, and each can stop the send:
 *
 * 1. **Suppression.** Checked first, because mailing a known-bad address costs
 *    the whole platform's sending reputation and nothing else here can undo it.
 * 2. **Sender resolution.** No verified domain means no send — there is
 *    deliberately no fallback to Resend and to `markii.shop` (G1).
 * 3. **The send itself**, via SES.
 * 4. **Recording the outcome** in `email_deliveries`, whatever it was. "Did the
 *    customer get their receipt?" is a support question that arrives days later.
 *
 * The result is a value, never a throw: a caller that swallowed an exception
 * here would report a confirmation that never left the building.
 */
export async function sendMerchantMail(
  orgId: string,
  input: MerchantMailInput,
): Promise<SendResult> {
  const to = Array.isArray(input.to) ? input.to : [input.to];
  const primary = normalizeEmail(to[0] ?? "");

  const record = (
    status: (typeof emailDeliveries.$inferInsert)["status"],
    provider: (typeof emailDeliveries.$inferInsert)["provider"],
    extra: { messageId?: string | null; reason?: string | null },
  ) =>
    db
      .insert(emailDeliveries)
      .values({
        orgId,
        template: input.template,
        toEmail: primary,
        subject: input.subject,
        provider,
        status,
        providerMessageId: extra.messageId ?? null,
        reason: extra.reason ?? null,
        orderId: input.orderId ?? null,
      })
      // Logging must never be the reason a send is reported as failed.
      .catch((e) => {
        console.error("[email] could not record delivery", e);
      });

  const suppressed = await suppressionFor(orgId, primary);
  if (suppressed) {
    const reason =
      suppressed.reason === "complaint"
        ? `${primary} reported earlier mail as spam and will not be contacted again.`
        : `${primary} is suppressed (${suppressed.reason}${suppressed.detail ? `: ${suppressed.detail}` : ""}).`;
    await record("suppressed", "none", { reason });
    return { sent: false, provider: "none", reason };
  }

  const verified = await resolveSender(orgId);

  /**
   * The storefront's own address, and **only for shopper account mail**.
   *
   * The template prefix is checked here rather than trusted from the caller: a
   * receipt sent from Markii's namespace is the exact G1 violation the two
   * streams exist to prevent, and a field a caller could set wrongly is not a
   * boundary. Auth mail is the one case where refusing is worse than an
   * unbranded sender — a shopper who cannot receive a confirmation cannot make
   * an account at all.
   */
  const fallback =
    !verified && input.tenantFallback && input.template.startsWith("auth_") && isSesConfigured()
      ? tenantFallbackSender(input.tenantFallback)
      : null;

  const sender = verified ?? fallback;
  if (!sender) {
    const reason = isSesConfigured()
      ? "No verified sending domain. Verify a domain in Settings → Email before sending " +
        "customer mail — Markii will not send it from markii.shop on your behalf."
      : "Merchant email is not configured on this deployment — AWS SES is not connected " +
        "(docs/BACKEND.md §6).";
    await record("not_configured", "none", { reason });
    return { sent: false, provider: "none", reason };
  }

  const result = await sendViaSes(input, {
    address: sender.address,
    name: sender.name,
    replyTo: sender.replyTo,
  });

  if (result.sent) {
    await record("sent", "ses", { messageId: result.id });
  } else {
    await record("failed", result.provider, { reason: result.reason });
  }
  return result;
}

/** For status surfaces: which streams can actually deliver right now. */
export function emailStatus() {
  return {
    platform: isResendConfigured()
      ? ("ready" as const)
      : ("configuration_required" as const),
    merchant: isSesConfigured() ? ("ready" as const) : ("configuration_required" as const),
  };
}

/**
 * Whether a specific org can send customer mail right now.
 *
 * Distinct from {@link emailStatus}: SES can be perfectly configured while a
 * given merchant still has no verified domain, and those are different problems
 * with different owners — ours and theirs.
 */
export async function merchantEmailStatus(orgId: string): Promise<{
  canSend: boolean;
  code: "ready" | "configuration_required" | "domain_verification_required";
  message: string;
  senderAddress: string | null;
}> {
  if (!isSesConfigured()) {
    return {
      canSend: false,
      code: "configuration_required",
      message: "AWS SES is not connected on this deployment, so no customer mail can be sent.",
      senderAddress: null,
    };
  }
  const sender = await resolveSender(orgId);
  if (!sender) {
    return {
      canSend: false,
      code: "domain_verification_required",
      message:
        "Verify a sending domain in Settings → Email. Customer mail is sent from your own " +
        "domain, never from markii.shop.",
      senderAddress: null,
    };
  }
  return {
    canSend: true,
    code: "ready",
    message: `Customer mail sends from ${sender.address}.`,
    senderAddress: sender.address,
  };
}
