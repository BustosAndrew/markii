import { z } from "zod";
import { badRequest, notFound } from "../../api";
import { getIntegration, integrationStatus, upsertIntegration, type Provider } from "../../integrations";
import { defineAction } from "../registry";

/**
 * Payment and service integrations (§8, §18.4).
 *
 * **These were route handlers until D40, and moving them fixed two real holes.**
 *
 * 1. **No permission was checked at all.** `PUT /api/integrations/:provider` ran
 *    under `orgHandler` with no `permission` option, so *any* authenticated
 *    staff member could change the x402 wallet address — including `analyst` and
 *    `viewer`, whose entire definition is "read-only, deliberately no write
 *    anywhere". That is the payout destination: a viewer could redirect the
 *    merchant's revenue.
 * 2. **No step-up.** §22 rule 1 says no route handler mutates outside the
 *    registry, and this one predated the rule, so `requiresStepUp` had nowhere
 *    to attach and the check had to be bolted onto the route by hand.
 *
 * Both follow from being outside the registry, which is the argument for the
 * rule rather than an exception to it. As actions they also land in
 * `action_invocations`, so "who changed the payout address, and when" finally
 * has an answer — it did not before.
 */

const configSchemas: Record<Provider, z.ZodType<Record<string, string>>> = {
  x402: z
    .object({
      walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not a valid EVM address"),
    })
    .strict(),
  google: z.object({ serviceAccountJson: z.string().min(2) }).strict(),
  /** Present for exhaustiveness; the action refuses Stripe outright below. */
  stripe: z.object({}).strict(),
};

const providerSchema = z.enum(["x402", "google", "stripe"]);

export const connectIntegration = defineAction({
  id: "integrations.connect",
  description:
    "Connect or update an integration for this organization. For x402 this sets the wallet " +
    "address that store revenue is paid to. Stripe is refused here — it connects through OAuth.",
  input: z
    .object({
      provider: providerSchema,
      config: z.record(z.string(), z.string()),
    })
    .strict(),
  /**
   * **`billing.write`, which is owner and administrator only.** The wallet
   * address decides where a merchant's money lands, so it belongs with the
   * authority over money rather than with general org settings — and notably not
   * with `developer`, whose role comment already says "no authority over money".
   */
  permission: "billing.write",
  /** Changing where revenue is paid. Nothing in this codebase outranks it. */
  riskTier: "high",
  requiresStepUp: true,
  /**
   * The Google service-account JSON is a credential. The audit row is long-lived
   * and widely readable, so it must never carry one.
   */
  redactInput: (input) => ({
    provider: input.provider,
    config:
      input.provider === "google"
        ? { serviceAccountJson: "[redacted]" }
        : input.config,
  }),
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;

    if (input.provider === "stripe") {
      throw badRequest(
        "Stripe is connected through Connect Standard OAuth, not by supplying a key. Markii never " +
          "stores a merchant secret key — you keep your own Stripe account, rates, dashboard, and " +
          "payouts. Connect via Settings → Integrations.",
      );
    }

    const config = configSchemas[input.provider].parse(input.config);
    if (input.provider === "google") {
      try {
        JSON.parse(config.serviceAccountJson);
      } catch {
        throw badRequest("serviceAccountJson is not valid JSON");
      }
    }

    const existing = await getIntegration(orgId, input.provider);

    /**
     * Recorded because this is the diff anyone investigating a redirected payout
     * will look for first. The **old and new wallet address**, on the invocation,
     * with an actor attached.
     */
    if (input.provider === "x402") {
      ctx.recordDiff({
        entity: "integration",
        entityId: `${orgId}:x402`,
        path: "walletAddress",
        before: existing?.config.walletAddress ?? null,
        after: config.walletAddress,
      });
    }

    const row = await upsertIntegration(orgId, input.provider, "connected", {
      ...existing?.config,
      ...config,
    });

    return integrationStatus(input.provider, row);
  },
});

export const disconnectIntegration = defineAction({
  id: "integrations.disconnect",
  description:
    "Disconnect an integration. For x402 this removes the wallet revenue is paid to, so the " +
    "store can no longer take payment on that rail.",
  input: z.object({ provider: providerSchema }).strict(),
  permission: "billing.write",
  /** Turning off a payment rail stops money arriving — the same decision reversed. */
  riskTier: "high",
  requiresStepUp: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;

    const existing = await getIntegration(orgId, input.provider);
    ctx.recordDiff({
      entity: "integration",
      entityId: `${orgId}:${input.provider}`,
      path: "status",
      before: existing?.status ?? null,
      after: "not_connected",
    });

    /**
     * Config is cleared rather than kept. A disconnected rail holding a stale
     * wallet address would quietly resume paying an old destination if it were
     * ever reconnected without one being supplied.
     */
    const row = await upsertIntegration(orgId, input.provider, "not_connected", {});
    return integrationStatus(input.provider, row);
  },
});
