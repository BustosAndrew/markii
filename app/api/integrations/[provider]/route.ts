import { NextResponse } from "next/server";
import { badRequest } from "@/lib/api";
import { invokeAction } from "@/lib/actions";
import { orgHandler } from "@/lib/auth/handler";
import type { Provider } from "@/lib/integrations";

/**
 * `/api/integrations/:provider` (§8) — connect or disconnect a rail.
 *
 * **These delegate to the registry now; they used to mutate directly.** That was
 * a §22 rule 1 violation, and it cost exactly what the rule predicts: the route
 * ran with **no permission check at all**, so any authenticated staff member —
 * `analyst` and `viewer` included, whose roles are read-only by definition —
 * could change the x402 wallet address, which is where the merchant's revenue is
 * paid. It also had nowhere to hang a step-up requirement, so one had to be
 * bolted on by hand.
 *
 * `integrations.connect` / `integrations.disconnect` now carry the permission
 * (`billing.write` — owner and administrator only), the `high` risk tier, and
 * `requiresStepUp`, and every change lands in `action_invocations` with the old
 * and new wallet address on the diff.
 */

function parseProvider(raw: string): Provider {
  if (raw !== "x402" && raw !== "google" && raw !== "stripe")
    throw badRequest(`unknown provider "${raw}" (expected x402, google or stripe)`);
  return raw;
}

export const PUT = orgHandler(async (req, { params, session }) => {
  const provider = parseProvider((await params).provider);
  const config = (await req.json()) as Record<string, string>;

  const outcome = await invokeAction(
    "integrations.connect",
    { provider, config },
    { actor: session.actor },
  );
  /**
   * The resource, not the invocation envelope — this endpoint predates the
   * registry and clients read the status object directly. The audit row still
   * gets written either way.
   */
  return NextResponse.json(outcome.result);
});

export const DELETE = orgHandler(async (_req, { params, session }) => {
  const provider = parseProvider((await params).provider);

  const outcome = await invokeAction(
    "integrations.disconnect",
    { provider },
    { actor: session.actor },
  );
  return NextResponse.json(outcome.result);
});
