import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { assertStepUp } from "@/lib/auth/mfa";
import {
  getIntegration,
  integrationStatus,
  upsertIntegration,
  type Provider,
} from "@/lib/integrations";

const configSchemas: Record<Provider, z.ZodType<Record<string, string>>> = {
  x402: z.object({ walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not a valid EVM address") }),
  google: z.object({
    merchantId: z.string().min(1),
    serviceAccountJson: z.string().min(2),
  }),
  /**
   * **Refuses everything.** Stripe is connected through Connect Standard OAuth
   * (D4), where the merchant keeps their own account and Markii holds a
   * revocable connection — never their secret key. This route used to accept
   * and store `sk_…` in plaintext jsonb, which hands Markii full control of a
   * merchant's charges, refunds, payouts, and customer data, and is exactly
   * what `docs/API.md` §8 says must never happen.
   */
  stripe: z.never(),
};

function parseProvider(raw: string): Provider {
  if (raw !== "x402" && raw !== "google" && raw !== "stripe")
    throw badRequest(`unknown provider "${raw}" (expected x402, google or stripe)`);
  return raw;
}

/**
 * **Step-up before changing where money goes** (D40).
 *
 * `x402.walletAddress` is the payout destination: changing it redirects a
 * merchant's revenue, which makes this the highest-value write in the product.
 * Disconnecting a rail is the same decision in reverse.
 *
 * **This check belongs in the action registry and is here under protest.** §22
 * rule 1 says no route handler mutates outside the registry, and this one
 * predates that rule — so there is no `defineAction` to hang `requiresStepUp`
 * on. A route-level check is complete only because no agent path to this
 * mutation exists *yet*; the moment it becomes an action, the check moves and
 * this comment goes with it. Leaving it unguarded until then would mean the one
 * write worth stealing is the one write with no second factor.
 */
async function stepUpForMoneyMove(session: { actor: { type: "user" | "agent" | "token" | "system" } }, what: string) {
  await assertStepUp(session.actor, what);
}

export const PUT = orgHandler(async (req, { params, orgId, session }) => {
  const provider = parseProvider((await params).provider);
  await stepUpForMoneyMove(session, `integrations.connect:${provider}`);

  if (provider === "stripe") {
    throw badRequest(
      "Stripe is connected through Connect Standard OAuth, not by supplying a key. Markii never " +
        "stores a merchant secret key — you keep your own Stripe account, rates, dashboard, and " +
        "payouts (docs/DECISIONS.md D4). The connection is established by the OAuth flow and kept " +
        "current by account.updated webhooks.",
    );
  }

  const config = configSchemas[provider].parse(await req.json());
  if (provider === "google") {
    try {
      JSON.parse(config.serviceAccountJson);
    } catch {
      throw badRequest("serviceAccountJson is not valid JSON");
    }
  }
  const existing = await getIntegration(orgId, provider);
  const row = await upsertIntegration(orgId, provider, "connected", {
    ...existing?.config,
    ...config,
  });
  return NextResponse.json(integrationStatus(provider, row));
});

export const DELETE = orgHandler(async (_req, { params, orgId, session }) => {
  const provider = parseProvider((await params).provider);
  await stepUpForMoneyMove(session, `integrations.disconnect:${provider}`);
  const row = await upsertIntegration(orgId, provider, "not_connected", {});
  return NextResponse.json(integrationStatus(provider, row));
});
