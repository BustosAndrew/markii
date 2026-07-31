import "server-only";

import { isResendConfigured, sendViaResend } from "./resend";
import { isSesConfigured, sendViaSes } from "./ses";
import type { MailInput, SendResult } from "./types";

export type { MailInput, SendResult } from "./types";
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
 * `orgId` is required even though SES is not wired yet: it is what selects the
 * merchant's sending identity, and adding it later would mean revisiting every
 * caller. Returns `{ sent: false }` until SES lands — it deliberately does not
 * fall back to Resend.
 */
export function sendMerchantMail(
  _orgId: string,
  input: MailInput,
): Promise<SendResult> {
  return sendViaSes(input);
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
