import { button, esc, paragraph, renderHtml, renderText, type RenderedEmail } from "./layout";

/**
 * Shopper account mail (§24, Supabase Send Email Hook).
 *
 * **These are the merchant's emails, not Markii's.** A shopper creating an
 * account on Acme's storefront is Acme's customer, so the message says Acme,
 * comes from Acme's verified domain, and never mentions Markii — the same rule
 * that governs order confirmations, applied to the mail that comes before them.
 *
 * Two things shape every template here:
 *
 * - **The link is the credential.** These carry a one-time token. It is never
 *   shortened, wrapped in a tracking redirect, or logged by callers — a token in
 *   an application log is a credential in an application log, and a redirect
 *   that hides the destination trains shoppers to click links they cannot read.
 * - **The plain-text alternative carries the same URL.** Auth mail lands in
 *   clients that strip HTML far more often than receipts do, and a shopper who
 *   cannot see the link cannot get into their account.
 */

export type AuthMailContext = {
  /** The merchant's store name — whose account this is. */
  storeName: string;
  /** Fully-formed confirmation URL, token included. Never truncate it. */
  actionUrl: string;
  /** Shown so a recipient who did not expect this knows what to ignore. */
  toEmail: string;
};

function shell(input: {
  storeName: string;
  heading: string;
  lead: string;
  cta: string;
  actionUrl: string;
  closing: string;
  toEmail: string;
}): RenderedEmail {
  const html = renderHtml({
    storeName: input.storeName,
    heading: input.heading,
    blocks: [
      paragraph(input.lead),
      button(input.cta, input.actionUrl),
      /**
       * The bare URL is repeated beneath the button because a button is an
       * anchor, and anchors are exactly what a cautious shopper is told not to
       * trust. Seeing the destination is what makes the link checkable.
       */
      paragraph(
        `If the button does not work, paste this into your browser:<br>${esc(input.actionUrl)}`,
      ),
      paragraph(input.closing),
    ],
    footer: [`Sent to ${esc(input.toEmail)} by ${esc(input.storeName)}.`],
  });

  const text = renderText([
    input.heading,
    "",
    input.lead,
    "",
    input.actionUrl,
    "",
    input.closing,
    "",
    `Sent to ${input.toEmail} by ${input.storeName}.`,
  ]);

  return { subject: `${input.heading} · ${input.storeName}`, html, text };
}

/** Double opt-in on account creation. */
export function confirmSignupEmail(ctx: AuthMailContext): RenderedEmail {
  return shell({
    storeName: ctx.storeName,
    heading: "Confirm your email",
    lead: `Confirm this address to finish creating your ${esc(ctx.storeName)} account.`,
    cta: "Confirm email",
    actionUrl: ctx.actionUrl,
    // Never "your account will be deleted" — an unconfirmed account is inert,
    // and a false threat is a false statement.
    closing: "If you did not create an account, you can ignore this email — nothing will happen.",
    toEmail: ctx.toEmail,
  });
}

export function resetPasswordEmail(ctx: AuthMailContext): RenderedEmail {
  return shell({
    storeName: ctx.storeName,
    heading: "Reset your password",
    lead: `Someone asked to reset the password for your ${esc(ctx.storeName)} account.`,
    cta: "Choose a new password",
    actionUrl: ctx.actionUrl,
    /**
     * Says the password is unchanged rather than only "ignore this". A reset
     * mail a shopper did not request is alarming, and the useful reassurance is
     * that nothing has happened yet.
     */
    closing:
      "If you did not ask for this, ignore this email — your password has not been changed.",
    toEmail: ctx.toEmail,
  });
}

export function magicLinkEmail(ctx: AuthMailContext): RenderedEmail {
  return shell({
    storeName: ctx.storeName,
    heading: "Your sign-in link",
    lead: `Use this link to sign in to ${esc(ctx.storeName)}. It works once and then expires.`,
    cta: "Sign in",
    actionUrl: ctx.actionUrl,
    closing: "If you did not ask to sign in, ignore this email.",
    toEmail: ctx.toEmail,
  });
}

/**
 * Email change confirmation.
 *
 * Supabase sends this to **both** addresses when Secure Email Change is on, and
 * the copy has to read correctly at either end — so it names the address it was
 * sent to rather than assuming "your new address".
 */
export function emailChangeEmail(ctx: AuthMailContext): RenderedEmail {
  return shell({
    storeName: ctx.storeName,
    heading: "Confirm your email change",
    lead: `Confirm this change to the email address on your ${esc(ctx.storeName)} account.`,
    cta: "Confirm change",
    actionUrl: ctx.actionUrl,
    closing:
      "If you did not ask to change your email address, ignore this — the change will not take effect.",
    toEmail: ctx.toEmail,
  });
}
