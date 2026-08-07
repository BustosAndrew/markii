import "server-only";

import { randomBytes } from "node:crypto";

/**
 * Stripe Connect Standard OAuth (D4).
 *
 * **The merchant authorises Markii against their own Stripe account.** They keep
 * the account, its rates, its dashboard, and its payouts; Markii receives a
 * `stripe_user_id` (`acct_…`) and creates charges with `Stripe-Account`. No
 * merchant secret key is ever requested, received, or stored — that is the whole
 * point of the flow, and `PUT /api/integrations/stripe` refuses one precisely so
 * this is the only way in.
 *
 * Hand-rolled over `fetch` rather than pulling in the Stripe SDK, matching the
 * SigV4, SNS, and webhook-signature code. The surface is two calls: exchange an
 * authorization code, and read an account. When charge creation lands the SDK
 * will earn its place — it does not for these.
 */

const OAUTH_AUTHORIZE = "https://connect.stripe.com/oauth/authorize";
const OAUTH_TOKEN = "https://connect.stripe.com/oauth/token";
const ACCOUNTS = "https://api.stripe.com/v1/accounts";

export function connectConfigured(): boolean {
  return Boolean(process.env.STRIPE_CONNECT_CLIENT_ID && process.env.STRIPE_SECRET_KEY);
}

/**
 * The OAuth redirect URI, pinned by env rather than derived from the request.
 *
 * **Stripe matches this string exactly against what is registered**, and derives
 * nothing. Building it from `appUrl()` alone is wrong in two situations that both
 * happen routinely:
 *
 * - **Preview deployments.** `appUrl()` falls back to `VERCEL_URL`, which is a
 *   different hostname on every deploy, so a preview would send Stripe a
 *   `redirect_uri` it has never seen and the merchant gets an error page.
 * - **Local development.** Stripe requires `https`, and the dev server is
 *   `http://localhost:3000` unless it is started with `--experimental-https`.
 *
 * So the URI is configurable on its own, and only falls back to the app URL when
 * nothing is set. Whatever it resolves to must be registered in Stripe verbatim.
 */
export function connectRedirectUri(appBaseUrl: string): string {
  const pinned = process.env.STRIPE_CONNECT_REDIRECT_URI;
  return pinned && pinned.length > 0
    ? pinned
    : `${appBaseUrl.replace(/\/$/, "")}/api/integrations/stripe/callback`;
}

/**
 * A random value tying the callback to the request that started it.
 *
 * **Without it the callback is a CSRF endpoint**: an attacker who gets a
 * merchant to load a crafted callback URL could attach *their own* Stripe
 * account to that merchant's org, and every subsequent card payment would settle
 * into the attacker's account. The state is stored server-side against the org
 * and required to match on return.
 */
export function newOauthState(): string {
  return randomBytes(32).toString("hex");
}

/** Where Stripe sends the merchant to authorise. */
export function authorizeUrl(input: { state: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.STRIPE_CONNECT_CLIENT_ID ?? "",
    scope: "read_write",
    redirect_uri: input.redirectUri,
    state: input.state,
    /**
     * Standard, explicitly. The account type is a *product* decision (D4) and
     * must not be left to whatever the Connect settings default happens to be:
     * Express or Custom would make Markii the party to the funds flow and would
     * quietly falsify the "your Stripe account, your rates" claim.
     */
    "stripe_user[business_type]": "company",
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

export type ConnectExchange =
  | { ok: true; accountId: string }
  | { ok: false; reason: string };

/**
 * Exchanges the one-time `code` for the merchant's account id.
 *
 * The response also carries an access token. **It is deliberately not returned
 * or stored.** Under Standard, Markii acts on the account with its own platform
 * key plus `Stripe-Account`; the OAuth access token is a second credential with
 * no additional use here, and storing an unused credential is pure liability.
 */
export async function exchangeCode(code: string): Promise<ConnectExchange> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return { ok: false, reason: "Markii has no Stripe credentials configured." };

  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${secret}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not reach Stripe." };
  }

  const body = (await res.json().catch(() => ({}))) as {
    stripe_user_id?: string;
    error_description?: string;
    error?: string;
  };

  if (!res.ok || !body.stripe_user_id) {
    // Stripe's own wording, surfaced rather than replaced with a generic
    // failure — "authorization code already used" is actionable; "failed" is not.
    return {
      ok: false,
      reason: body.error_description ?? body.error ?? `Stripe returned ${res.status}.`,
    };
  }
  return { ok: true, accountId: body.stripe_user_id };
}

export type ConnectAccount = {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
};

/**
 * Reads an account's current capabilities.
 *
 * Called once at connect time so the merchant sees a truthful state immediately
 * rather than waiting for the first `account.updated` webhook — which may not
 * arrive for a while, and never arrives at all if nothing about the account
 * changes after they authorise.
 */
export async function fetchAccount(accountId: string): Promise<ConnectAccount | null> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return null;

  try {
    const res = await fetch(`${ACCOUNTS}/${encodeURIComponent(accountId)}`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      id?: string;
      charges_enabled?: boolean;
      payouts_enabled?: boolean;
      requirements?: { currently_due?: string[] };
    };
    return {
      accountId: body.id ?? accountId,
      chargesEnabled: Boolean(body.charges_enabled),
      payoutsEnabled: Boolean(body.payouts_enabled),
      requirementsDue: body.requirements?.currently_due ?? [],
    };
  } catch {
    return null;
  }
}
