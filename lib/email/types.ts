/**
 * Email is split by **whose mail it is**, and the split is load-bearing: it is
 * what keeps a merchant's sending reputation from ever touching Markii's own
 * (`CLAUDE.md`, `docs/DECISIONS.md` §"Email — G1").
 *
 * - `sendPlatformMail()` → **Resend**, from `markii.shop`. Markii's own mail
 *   only: contact form, support, staff auth, invoices, dunning, platform notices.
 * - `sendMerchantMail()` → **AWS SES**, from the merchant's own verified domain.
 *   Everything sent on a merchant's behalf: order confirmations, shipping and
 *   refund notices, digital delivery, abandoned cart, shopper account mail.
 *
 * Callers pick the **stream**, never the provider. A caller that reaches for a
 * provider directly is how the reputations get mixed.
 */

export type MailAddress = string;

export type MailInput = {
  to: MailAddress | MailAddress[];
  subject: string;
  /** At least one of `html` / `text` is required. */
  html?: string;
  text?: string;
  replyTo?: MailAddress;
};

/**
 * Merchant mail carries two extra fields, and both are required rather than
 * optional on purpose.
 *
 * `template` is what makes `email_deliveries` answerable months later — "which
 * of our emails is bouncing?" cannot be reconstructed from a subject line a
 * merchant has since reworded. `orderId` is what ties a delivery back to the
 * order a support conversation is actually about.
 */
export type MerchantMailInput = MailInput & {
  /** A `TemplateId` from `lib/email/templates/`. */
  template: string;
  orderId?: number | null;
};

/**
 * A discriminated union rather than a thrown error, deliberately.
 *
 * §16 requires that an invitation is never reported as delivered unless a
 * provider accepted it. Returning `{ sent: false, reason }` makes the unsent
 * case something the caller has to look at, instead of an exception it might
 * swallow — or worse, a silent success.
 */
export type SendResult =
  | { sent: true; id: string; provider: "resend" | "ses" }
  | { sent: false; reason: string; provider: "resend" | "ses" | "none" };

export class EmailNotConfiguredError extends Error {}
