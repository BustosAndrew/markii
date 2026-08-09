import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites } from "@/lib/db";
import { getIntegration, integrationStatus, PAYMENT_RAILS } from "@/lib/integrations";
import { eq } from "drizzle-orm";

/**
 * `GET /api/payments` (§8) — the rails this organization can take money on.
 *
 * Separate from `GET /api/integrations` so the Payments screen is not built out
 * of a response that also carries a Google product feed. They were one endpoint
 * until 2026-08-08, and mixing them is what let a catalog integration inherit
 * the authority rules of the wallet address sitting beside it.
 *
 * **Read-only, and `billing.read` rather than `billing.write`** — seeing whether
 * a store can take payment is a reporting question. Changing it is not, and goes
 * through `payments.connectRail` with step-up.
 *
 * **This deliberately reports no balance and no payout figures.** Markii never
 * holds merchant funds (D4) and uses Connect Standard, so the merchant's own
 * Stripe dashboard is the source of truth for their balance — restating it here
 * would mean publishing a number Markii does not own, which goes stale between
 * the two systems and is then trusted by whoever read it last. x402 has no
 * balance concept at all: it settles on-chain to the merchant's wallet, so a
 * single "balance" across rails would have to invent one for that rail.
 *
 * What Markii *is* the source of truth for — orders, net sales, refunds across
 * every rail, and the threshold meter — lives under Orders → Settlements and
 * `GET /api/billing/usage`.
 */
export const GET = orgHandler(
  async (_req, { orgId }) => {
    const rails = await Promise.all(
      PAYMENT_RAILS.map(async (rail) => {
        const row = await getIntegration(orgId, rail);
        const status = integrationStatus(rail, row) as Record<string, unknown>;
        return {
          rail,
          ...status,
          /**
           * **Connected is not the same as able to take money.** Stripe enables
           * charges only after verification, and a store told it accepts cards
           * in that window fails the shopper at card entry. For x402 the wallet
           * is the whole requirement.
           */
          canAcceptPayments:
            rail === "stripe"
              ? status.status === "connected" && status.chargesEnabled === true
              : status.status === "connected" && Boolean(status.walletAddress),
        };
      }),
    );

    /**
     * Which rails each storefront actually offers. A rail can be connected at
     * the org while a particular store has it switched off, and the Payments
     * screen has to show both facts or a merchant cannot explain why a live
     * store is refusing cards.
     */
    const stores = await db
      .select({
        id: sites.id,
        slug: sites.slug,
        name: sites.name,
        paymentProviders: sites.paymentProviders,
        walletAddress: sites.walletAddress,
      })
      .from(sites)
      .where(eq(sites.orgId, orgId));

    return NextResponse.json({
      rails,
      stores: stores.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        enabled: s.paymentProviders,
        /** A per-store override; null means the org default is used. */
        walletAddressOverride: s.walletAddress,
      })),
      /**
       * Said in the response rather than left to the screen, so no Payments UI
       * has to decide on its own whether to render a balance it cannot source.
       */
      balances: null,
      balancesNote:
        "Markii never holds your funds. Balances, payouts, and processor fees live in your own " +
        "Stripe dashboard; x402 settles on-chain directly to your wallet.",
    });
  },
  { permission: "billing.read" },
);
