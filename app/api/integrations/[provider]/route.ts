import { NextResponse } from "next/server";
import { badRequest } from "@/lib/api";
import { invokeAction } from "@/lib/actions";
import { orgHandler } from "@/lib/auth/handler";
import { isPaymentRail, type Provider } from "@/lib/integrations";

/**
 * `/api/integrations/:provider` (§8) — connect or disconnect an outside service.
 *
 * **Dispatches by what the provider can cost.** A payment rail routes to
 * `payments.connectRail` (`billing.write`, step-up, `high`); a catalog feed to
 * `integrations.connect` (`catalog.write`, no step-up). The URL is unchanged so
 * existing callers keep working, but the authority applied is no longer the same
 * for both — which it was until 2026-08-08, when connecting a Google product
 * feed required the permission to move money.
 *
 * Neither branch mutates here. The registry is the only mutation path (§22 rule
 * 1), which is what earned both the permission check and the step-up: this route
 * previously ran with **no permission option at all**, so any staff member —
 * `viewer` included — could change the x402 wallet address.
 */

function parseProvider(raw: string): Provider {
  if (raw !== "x402" && raw !== "google" && raw !== "stripe")
    throw badRequest(`unknown provider "${raw}" (expected x402, google or stripe)`);
  return raw;
}

export const PUT = orgHandler(async (req, { params, session }) => {
  const provider = parseProvider((await params).provider);
  const config = (await req.json()) as Record<string, string>;

  const outcome = isPaymentRail(provider)
    ? await invokeAction(
        "payments.connectRail",
        { rail: provider, config },
        { actor: session.actor },
      )
    : await invokeAction(
        "integrations.connect",
        { provider, config },
        { actor: session.actor },
      );

  /**
   * The resource, not the invocation envelope — this endpoint predates the
   * registry and callers read the status object directly. The audit row is
   * written either way.
   */
  return NextResponse.json(outcome.result);
});

export const DELETE = orgHandler(async (_req, { params, session }) => {
  const provider = parseProvider((await params).provider);

  const outcome = isPaymentRail(provider)
    ? await invokeAction("payments.disconnectRail", { rail: provider }, { actor: session.actor })
    : await invokeAction("integrations.disconnect", { provider }, { actor: session.actor });

  return NextResponse.json(outcome.result);
});
