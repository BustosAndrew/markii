import { button, paragraph, renderHtml, renderText, type RenderedEmail } from "./layout";

/**
 * "Your free month is ending" — **Markii's own mail to a merchant**, so it goes
 * out through Resend from `markii.shop`, never SES from the merchant's domain.
 * It belongs to the same stream as invoices and dunning notices (CLAUDE.md,
 * "Email is split by whose mail it is").
 *
 * The copy is shaped by what actually happens next, which is severe: the
 * storefront stops serving and stops accepting orders. So this states the
 * consequence plainly and gives the date. Softening it — "your trial is ending,
 * upgrade for more features" — would be the fabrication rule pointed at a
 * merchant, because it describes an upsell when what is coming is a stop.
 *
 * It manufactures no urgency beyond the real deadline: no discount timer, no
 * invented scarcity. The deadline is genuine and is enough.
 */

export type TrialEndingContext = {
  orgName: string;
  /** Rendered by the caller in the merchant's own locale-free ISO date. */
  endsOn: string;
  daysLeft: number;
  /** Absolute URL to the subscription screen. */
  subscribeUrl: string;
};

export function trialEnding(ctx: TrialEndingContext): RenderedEmail {
  const when =
    ctx.daysLeft <= 0
      ? "today"
      : ctx.daysLeft === 1
        ? "tomorrow"
        : `in ${ctx.daysLeft} days`;

  const consequence =
    "When it ends, your storefront stops serving and stops accepting orders until you subscribe. " +
    "Your products, orders and customers are not deleted and stay available to you — " +
    "subscribing brings everything back online immediately.";

  const html = renderHtml({
    storeName: "Markii",
    heading: `Your free month ends ${when}`,
    blocks: [
      /**
       * Not pre-escaped: `paragraph` escapes its own argument, so calling `esc`
       * here too would render a store called "Ben & Jerry's" as "Ben &amp; Jerry's".
       */
      paragraph(
        `Your free month on Markii for ${ctx.orgName} ends on ${ctx.endsOn}. ` +
          "There is no card on file yet.",
      ),
      paragraph(consequence),
      button("Choose a plan", ctx.subscribeUrl),
      paragraph(
        "If you have already subscribed since this was sent, no action is needed and you can ignore this.",
      ),
    ],
  });

  const text = renderText([
    `Your free month ends ${when}`,
    "",
    `Your free month on Markii for ${ctx.orgName} ends on ${ctx.endsOn}. There is no card on file yet.`,
    "",
    consequence,
    "",
    `Choose a plan: ${ctx.subscribeUrl}`,
    "",
    "If you have already subscribed since this was sent, no action is needed.",
  ]);

  return { subject: `Your Markii free month ends ${when}`, html, text };
}
