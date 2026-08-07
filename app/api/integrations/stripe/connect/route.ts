import { NextResponse } from "next/server";
import { appUrl } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { getIntegration, upsertIntegration } from "@/lib/integrations";
import {
  authorizeUrl,
  connectConfigured,
  connectRedirectUri,
  newOauthState,
} from "@/lib/payments/connect";

/**
 * `GET /api/integrations/stripe/connect` (§8) — start Connect Standard OAuth.
 *
 * Returns the URL to send the merchant to. It does **not** redirect: the caller
 * is the dashboard, and a JSON answer lets the screen show what is about to
 * happen — that they are going to Stripe, and that they keep their own account —
 * rather than teleporting them mid-click.
 *
 * The `state` is minted here and stored against the org. Without it the callback
 * would accept any account for any org, and a merchant tricked into loading a
 * crafted callback would have someone else's Stripe account attached to their
 * store — with every card payment settling into it.
 */
export const GET = orgHandler(
  async (_req, { orgId }) => {
    if (!connectConfigured()) {
      return NextResponse.json(
        {
          error: {
            code: "CONFIGURATION_REQUIRED",
            message: "Stripe Connect is not configured on this deployment.",
            details: {
              resolution:
                "Set STRIPE_CONNECT_CLIENT_ID (Stripe Dashboard → Connect → Settings) and " +
                "STRIPE_SECRET_KEY. Merchants cannot connect until both exist.",
            },
          },
        },
        { status: 503 },
      );
    }

    const state = newOauthState();
    const existing = await getIntegration(orgId, "stripe");

    /**
     * Stored with a timestamp so a stale state cannot be replayed indefinitely.
     * The row is left `not_connected` — starting the flow is not finishing it,
     * and marking it connected here would claim a card rail that does not exist.
     */
    await upsertIntegration(
      orgId,
      "stripe",
      existing?.status ?? "not_connected",
      { ...existing?.config, oauthState: state, oauthStateAt: new Date().toISOString() },
      existing?.message ?? null,
    );

    return NextResponse.json({
      url: authorizeUrl({ state, redirectUri: connectRedirectUri(appUrl()) }),
      mode: "connect_standard",
      note:
        "You keep your own Stripe account, rates, dashboard, and payouts. Markii never sees your " +
        "secret key, takes no cut of your payments, and never holds your funds.",
    });
  },
  { permission: "org.write" },
);
