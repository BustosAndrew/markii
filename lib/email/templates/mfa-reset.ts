import { paragraph, renderHtml, renderText, type RenderedEmail } from "./layout";

/**
 * "Your two-factor authentication was reset" (G12, `platform.resetMfa`).
 *
 * Markii's own mail about a Markii account, so it goes via `sendPlatformMail`
 * from `markii.shop`, never through a merchant's SES identity.
 *
 * **Sent whether or not the merchant asked for it**, and that is the point. If
 * they did, it confirms support acted. If they did not, it is the only way
 * they learn that someone talked Markii into stripping their second factor —
 * the one attack this action creates — and it tells them what to do.
 */
export type MfaResetContext = {
  orgName: string;
  signInUrl: string;
  supportAddress: string;
};

export function mfaReset(ctx: MfaResetContext): RenderedEmail {
  const what =
    `Markii support has removed the authenticator from your account on ${ctx.orgName}, ` +
    "and signed out every device you were signed in on.";
  const next =
    "The next time you sign in you will be asked to set up a new authenticator and will " +
    "receive new recovery codes. Your old recovery codes no longer work.";
  const notYou =
    `If you did not ask for this, reply to this email or write to ${ctx.supportAddress} ` +
    "immediately, and change your password.";

  const html = renderHtml({
    storeName: "Markii",
    heading: "Your two-factor authentication was reset",
    blocks: [paragraph(what), paragraph(next), paragraph(notYou), paragraph(`Sign in: ${ctx.signInUrl}`)],
  });

  const text = renderText([
    "Your two-factor authentication was reset",
    "",
    what,
    "",
    next,
    "",
    notYou,
    "",
    `Sign in: ${ctx.signInUrl}`,
  ]);

  return { subject: "Your Markii two-factor authentication was reset", html, text };
}
