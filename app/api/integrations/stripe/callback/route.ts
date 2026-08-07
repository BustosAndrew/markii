import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { getIntegration, upsertIntegration } from "@/lib/integrations";
import { exchangeCode, fetchAccount } from "@/lib/payments/connect";

/** How long a started OAuth flow stays valid. Long enough to read Stripe's forms. */
const STATE_TTL_MS = 30 * 60 * 1000;

/**
 * `GET /api/integrations/stripe/callback` (§8) — where Stripe returns.
 *
 * **The `state` check is the security of this endpoint, not a formality.** Without
 * it, anyone who can get a signed-in merchant to load this URL with their own
 * `code` attaches *their* Stripe account to *that merchant's* org — and every
 * card payment the store takes afterwards settles into the attacker's account.
 * The state must match the one minted for this org, and must not be stale.
 *
 * Redirects to the dashboard rather than returning JSON: the merchant's browser
 * is here, not a program.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    /**
     * Built from the **request's own origin**, not `appUrl()`.
     *
     * The merchant's browser is mid-flow here, and sending it to a different
     * origin than the one it is authenticated on drops the session cookie — over
     * https locally that means arriving at the dashboard logged out, with
     * nothing to explain why. The request URL is the one origin guaranteed to
     * match where they actually are.
     */
    const settings = new URL("/dashboard/integrations", req.url).toString();
    const fail = (reason: string) =>
      NextResponse.redirect(`${settings}?stripe=error&reason=${encodeURIComponent(reason)}`);

    /** The merchant pressed cancel on Stripe's screen. Not an error. */
    if (sp.get("error") === "access_denied") {
      return NextResponse.redirect(`${settings}?stripe=cancelled`);
    }

    const code = sp.get("code");
    const state = sp.get("state");
    if (!code || !state) return fail("Stripe did not return an authorization code.");

    const existing = await getIntegration(orgId, "stripe");
    const expected = existing?.config.oauthState;
    const startedAt = existing?.config.oauthStateAt
      ? Date.parse(existing.config.oauthStateAt)
      : NaN;

    if (!expected || expected !== state) {
      return fail("This connection request did not start here. Please try again from Settings.");
    }
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > STATE_TTL_MS) {
      return fail("That connection request expired. Please start again.");
    }

    const exchanged = await exchangeCode(code);
    if (!exchanged.ok) return fail(exchanged.reason);

    /**
     * Read the account immediately so the merchant sees a truthful state now.
     * If Stripe cannot be reached, the connection is still recorded — but with
     * `chargesEnabled: false`, because the honest default for "we do not know"
     * is the one that keeps card checkout off rather than the one that offers a
     * rail that may fail at the shopper's card entry.
     */
    const account = await fetchAccount(exchanged.accountId);

    /** The one-time state is consumed, so a replayed callback cannot re-attach. */
    const rest = { ...(existing?.config ?? {}) };
    delete rest.oauthState;
    delete rest.oauthStateAt;

    await upsertIntegration(
      orgId,
      "stripe",
      "connected",
      {
        ...rest,
        accountId: exchanged.accountId,
        chargesEnabled: String(account?.chargesEnabled ?? false),
        payoutsEnabled: String(account?.payoutsEnabled ?? false),
        requirementsDue: (account?.requirementsDue ?? []).join(","),
        connectedAt: new Date().toISOString(),
      },
      account?.chargesEnabled
        ? null
        : "Stripe has not enabled charges on this account yet — card checkout stays off until it does.",
    );

    return NextResponse.redirect(`${settings}?stripe=connected`);
  },
  { permission: "org.write" },
);
