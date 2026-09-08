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
  /**
   * The address an email change is moving to. Only set during a change, and
   * only the mail to the *current* address needs it — naming the destination is
   * what lets that reader tell a mistake from an attack.
   */
  newEmail?: string | null;
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
/**
 * The single-message flow, used when Supabase's *Secure email change* is off.
 * One mail, to the account holder.
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

/**
 * Sent to the address **currently** on the account.
 *
 * This is the message that stops an account takeover, so it names where the
 * account would move to. A reader who did not ask for this needs two facts to
 * act: that a change was requested, and what address it would move to. "Confirm
 * your email change" alone gives neither.
 *
 * The destination is stated even though it is attacker-chosen text: it is
 * escaped, and withholding it would leave the reader unable to tell a typo from
 * a hijack.
 */
export function emailChangeCurrentEmail(ctx: AuthMailContext): RenderedEmail {
  const destination = ctx.newEmail ? esc(ctx.newEmail) : null;
  return shell({
    storeName: ctx.storeName,
    heading: "Did you ask to change your email address?",
    lead: destination
      ? `Someone asked to move your ${esc(ctx.storeName)} account from this address to ` +
        `${destination}. Confirm below if that was you.`
      : `Someone asked to change the email address on your ${esc(ctx.storeName)} account. ` +
        "Confirm below if that was you.",
    cta: "Yes, confirm the change",
    actionUrl: ctx.actionUrl,
    /**
     * **Never "ignore this".** For the other auth mails an unexpected message is
     * inert, so ignoring it is correct advice. Here it means someone with access
     * to the account is moving it away from this address, and the right response
     * is to sign in and secure it.
     */
    closing:
      "If this was not you, do not confirm. Sign in and change your password — someone may " +
      "have access to your account. The change cannot complete without this confirmation.",
    toEmail: ctx.toEmail,
  });
}

/**
 * Sent to the **new** address, to prove it is reachable by whoever asked.
 *
 * Deliberately plain: this reader may have no account yet and no context, so it
 * asks one thing.
 */
export function emailChangeNewEmail(ctx: AuthMailContext): RenderedEmail {
  return shell({
    storeName: ctx.storeName,
    heading: "Confirm your new email address",
    lead: `Confirm this address to finish moving your ${esc(ctx.storeName)} account to it.`,
    cta: "Confirm this address",
    actionUrl: ctx.actionUrl,
    closing:
      "If you did not ask for this, ignore it — the change will not take effect without a " +
      "confirmation from the account's current address as well.",
    toEmail: ctx.toEmail,
  });
}
