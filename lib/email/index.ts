import "server-only";

import { eq } from "drizzle-orm";
import { db, emailDeliveries, orders, sites } from "../db";
import { resolveSender, tenantFallbackSender } from "./identity";
import { isResendConfigured, sendViaResend } from "./resend";
import { getSesIdentity, isSesConfigured, sendViaSes } from "./ses";
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
 * 2. **Sender resolution.** The merchant's own verified domain when it exists;
 *    otherwise the storefront's `{slug}.{ROOT_DOMAIN}` address (D44). Never
 *    Resend, and never bare `markii.shop` — the stream split still holds.
 * 3. **The send itself**, via SES.
 * 4. **Recording the outcome** in `email_deliveries`, whatever it was. "Did the
 *    customer get their receipt?" is a support question that arrives days later.
 *
 * The result is a value, never a throw: a caller that swallowed an exception
 * here would report a confirmation that never left the building.
 */
/**
 * The storefront whose address a fallback send goes out from.
 *
 * Takes `siteId` when the caller knows it, and otherwise derives it from the
 * order — which is what let the transactional callers keep their signatures
 * when the fallback widened past account mail (D44). Runs **only** when there is
 * no verified sender, so the happy path pays for neither lookup.
 */
async function fallbackSender(input: MerchantMailInput) {
  let siteId = input.siteId ?? null;

  if (siteId === null && input.orderId != null) {
    const [row] = await db
      .select({ siteId: orders.siteId })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);
    siteId = row?.siteId ?? null;
  }
  if (siteId === null) return null;

  const [site] = await db
    .select({ slug: sites.slug, name: sites.name })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  return site ? tenantFallbackSender({ slug: site.slug, storeName: site.name }) : null;
}

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
   * The storefront's own address, when the merchant has none of their own (D44).
   *
   * **This used to apply to account mail only, and refusing everything else was
   * wrong.** A store that takes an order and sends no receipt is broken: the
   * buyer has paid and heard nothing, and for a digital product the missing
   * email *is* the product — the download link never arrives. Silence is a worse
   * failure than an unbranded sender, so mail now goes from
   * `{slug}.{ROOT_DOMAIN}` rather than not going.
   *
   * The merchant's own verified domain still wins whenever it exists, and
   * `UNVERIFIED_SENDING_DOMAIN` (§9) nags until it does — the fallback is a floor, not a
   * destination. The cost it accepts is that those bounces land on Markii's
   * shared SES reputation, which is why the readiness finding stays loud.
   */
  const fallback =
    !verified && isSesConfigured() ? await fallbackSender(input) : null;

  const sender = verified ?? fallback;
  if (!sender) {
    const reason = isSesConfigured()
      ? "No verified sending domain, and no storefront to fall back to. Verify a domain in " +
        "Settings → Email so this mail sends from your own address."
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

/**
 * Whether the **fallback** sender is actually usable, checked against SES.
 *
 * `{slug}.{ROOT_DOMAIN}` sends only because SES covers subdomains of a verified
 * parent identity (D44). If `ROOT_DOMAIN` is not verified — or its DKIM lapses —
 * every fallback send fails at AWS, which would take out receipts for *every*
 * merchant who has not verified a domain of their own. That is a platform-wide
 * outage with no merchant able to fix it, and until now nothing could see it
 * coming: the deployment's IAM key cannot list identities or read the config
 * set, but it **can** call `GetEmailIdentity` on a name it already knows.
 *
 * Read live and never cached — a stale "healthy" is the failure mode here.
 */
export async function fallbackSenderHealth(): Promise<{
  ok: boolean;
  domain: string | null;
  verifiedForSending: boolean | null;
  dkimStatus: string | null;
  problem: string | null;
}> {
  const domain = process.env.ROOT_DOMAIN?.trim().toLowerCase() || null;
  const base = { domain, verifiedForSending: null, dkimStatus: null };

  if (!isSesConfigured()) {
    return { ...base, ok: false, problem: "AWS SES is not connected on this deployment." };
  }
  if (!domain || domain === "localhost" || domain.endsWith(".localhost")) {
    return { ...base, ok: false, problem: `ROOT_DOMAIN is ${domain ?? "unset"}; there is no fallback sender.` };
  }

  const res = await getSesIdentity(domain);
  if (!res.ok) return { ...base, ok: false, problem: res.reason };

  /**
   * DKIM matters as much as verification. Without it the fallback still sends
   * but signs nothing that aligns, so `p=quarantine` on the apex sends every
   * merchant's receipts to spam — mail that is accepted and never read.
   */
  const ok = res.state.verifiedForSending && res.state.dkimStatus === "SUCCESS";
  return {
    domain,
    ok,
    verifiedForSending: res.state.verifiedForSending,
    dkimStatus: res.state.dkimStatus,
    problem: ok
      ? null
      : `${domain} is not fully set up for sending in SES (verified: ` +
        `${res.state.verifiedForSending}, DKIM: ${res.state.dkimStatus}). Every merchant without ` +
        `their own verified domain depends on it.`,
  };
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
  code: "ready" | "configuration_required" | "unverified_sender";
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
    /**
     * **`canSend` is true here, and the code changed to say why** (D44). Mail
     * does go out — from the storefront's own `{slug}.{ROOT_DOMAIN}` address —
     * so the old `domain_verification_required` / `canSend: false` pair now
     * describes a refusal that no longer happens. Reporting "not sending" while
     * receipts arrive is the same class of lie as the reverse.
     *
     * `senderAddress` stays null because there isn't one answer: the address is
     * per storefront, and an org with several stores sends from several.
     */
    return {
      canSend: true,
      code: "unverified_sender",
      message:
        "Customer mail is sending from your storefront's Markii address. Verify your own domain " +
        "in Settings → Email so it comes from you — better deliverability, and your branding.",
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
