import { button, paragraph, renderHtml, renderText, type RenderedEmail } from "./layout";

/**
 * "Your renewal payment failed" — the three-step dunning sequence (D10).
 * **Markii's own mail**, via Resend from `markii.shop`, in the same stream as
 * invoices and the trial reminder; never a merchant's SES identity.
 *
 * Stripe's own failed-payment emails are **off** for the platform account,
 * so this is the only notice the merchant gets — which is why each one says
 * exactly what is held now and what is held next, with the date. The copy is
 * shaped by the ladder rather than by urgency theatre: day 0 is calm because
 * nothing is held and Stripe is retrying; day 13 is blunt because the next day
 * changes stop.
 */

export type DunningNoticeContext = {
  orgName: string;
  /** 0, 7 or 13 — which notice this is. */
  notice: 0 | 7 | 13;
  /** ISO date the card first failed. */
  failedOn: string;
  /** ISO date of the next rung, or null. */
  nextStepOn: string | null;
  /** Absolute URL to the billing screen, where the card is updated. */
  billingUrl: string;
};

export function dunningNotice(ctx: DunningNoticeContext): RenderedEmail {
  const { heading, subject, now, next } = copyFor(ctx);

  const html = renderHtml({
    storeName: "Markii",
    heading,
    blocks: [
      paragraph(
        `The renewal payment for ${ctx.orgName}'s Markii subscription failed on ${ctx.failedOn}. ` +
          "Stripe retries the card automatically; nothing further is needed once a retry succeeds.",
      ),
      paragraph(now),
      next ? paragraph(next) : "",
      button("Update your card", ctx.billingUrl),
      paragraph(
        "Your products, orders and customers are never deleted over a failed payment. " +
          "If the invoice has already been paid since this was sent, no action is needed.",
      ),
    ].filter(Boolean),
  });

  const text = renderText([
    heading,
    "",
    `The renewal payment for ${ctx.orgName}'s Markii subscription failed on ${ctx.failedOn}. ` +
      "Stripe retries the card automatically; nothing further is needed once a retry succeeds.",
    "",
    now,
    next ? "" : null,
    next,
    "",
    `Update your card: ${ctx.billingUrl}`,
    "",
    "Your products, orders and customers are never deleted over a failed payment. " +
      "If the invoice has already been paid since this was sent, no action is needed.",
  ]);

  return { subject, html, text };
}

function copyFor(ctx: DunningNoticeContext) {
  switch (ctx.notice) {
    case 0:
      return {
        subject: "Your Markii renewal payment failed",
        heading: "A renewal payment failed",
        now: "Everything keeps working while Stripe retries. Updating the card now avoids the retries failing the same way.",
        next: ctx.nextStepOn
          ? `If it is still unpaid on ${ctx.nextStepOn}, new storefronts will not be able to go live and new API tokens cannot be created until it is.`
          : null,
      };
    case 7:
      return {
        subject: "Your Markii renewal is a week overdue",
        heading: "A renewal payment has been failing for a week",
        now: "From today, new storefronts cannot go live and new API tokens cannot be created. Your live stores keep serving and you can keep editing them.",
        next: ctx.nextStepOn
          ? `If it is still unpaid on ${ctx.nextStepOn}, changes to your stores go on hold — the storefronts stay live, but nothing can be edited until the invoice is paid.`
          : null,
      };
    case 13:
      return {
        subject: "Action needed: changes to your Markii stores go on hold tomorrow",
        heading: "Changes go on hold tomorrow",
        now: "The renewal invoice is still unpaid. From tomorrow, edits to your stores are held until it is paid. Your storefronts keep serving and keep taking orders.",
        next: ctx.nextStepOn
          ? `If it is still unpaid on ${ctx.nextStepOn}, the storefronts stop serving. Paying the invoice at any point brings everything back immediately.`
          : null,
      };
  }
}
