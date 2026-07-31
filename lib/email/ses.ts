import "server-only";

import type { MailInput, SendResult } from "./types";

/**
 * SES transport — **merchant mail only** (G1): order confirmations, shipping and
 * refund notices, digital delivery, abandoned cart, shopper account mail. Sent
 * from the merchant's own verified domain, never Markii's.
 *
 * **Not built yet.** This returns an honest "not configured" rather than falling
 * back to Resend, which would be the single worst failure mode available here:
 * a merchant's order confirmations would send from Markii's domain, and their
 * bounces would land on Markii's sending reputation — exactly what the
 * two-provider split exists to prevent.
 *
 * What it needs before it can send (`docs/BACKEND.md` §6):
 *
 * 1. AWS credentials and a region (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 *    `AWS_REGION`).
 * 2. **Sandbox escape**, which is an AWS support request with a queue in front
 *    of it — not instant, and refusable.
 * 3. Bounce/complaint handling over SNS. AWS suspends senders above roughly 5%
 *    bounce or 0.1% complaint, so this is effectively mandatory, not optional.
 * 4. **Per-merchant domain verification** — the real work, and a product
 *    feature rather than a setup step: each merchant verifies their own domain,
 *    and a verified domain is required to go live (G1).
 */

export function isSesConfigured() {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION,
  );
}

export async function sendViaSes(_input: MailInput): Promise<SendResult> {
  return {
    sent: false,
    provider: "none",
    reason:
      "Merchant email is not configured yet — AWS SES is Phase C (docs/BACKEND.md §6). " +
      "Merchant mail must not fall back to Markii's own sending domain.",
  };
}
