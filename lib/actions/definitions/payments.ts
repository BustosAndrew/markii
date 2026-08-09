import { z } from "zod";
import { badRequest, notFound } from "../../api";
import {
  getIntegration,
  integrationStatus,
  upsertIntegration,
  PAYMENT_RAILS,
  type PaymentRail,
} from "../../integrations";
import { defineAction } from "../registry";

/**
 * Payment rails — **where a merchant's money is paid** (§8, §18.4).
 *
 * Split out from `integrations.*` on 2026-08-08. They shared a route and an
 * action until then, which meant one permission and one risk tier had to cover
 * both the x402 wallet address and a Google product feed. Sizing those rules for
 * the wallet — `billing.write`, `high`, step-up — was correct for the money and
 * absurd for the feed: a `catalog_manager` could no longer reconnect Merchant
 * Center, and doing so demanded a fresh MFA challenge.
 *
 * The registry's `permission` is static per action, and that is the right design
 * — it means an action has exactly one authority level, so a genuine difference
 * in stakes has to become a genuine second action rather than a conditional
 * nobody can audit.
 *
 * **What makes this class different:** changing the wallet address redirects
 * revenue to whoever set it, and turning a rail off stops money arriving at all.
 * Neither is recoverable by editing a row back afterwards — the payments have
 * already gone somewhere.
 */

const railSchema = z.enum(PAYMENT_RAILS);

/** Only x402 is configured by supplying anything; Stripe arrives through OAuth. */
const railConfigSchemas: Record<PaymentRail, z.ZodType<Record<string, string>>> = {
  x402: z
    .object({
      walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not a valid EVM address"),
    })
    .strict(),
  stripe: z.object({}).strict(),
};

export const connectRail = defineAction({
  id: "payments.connectRail",
  description:
    "Set or update where a store's payments are received. For x402 this is the wallet address " +
    "revenue is paid to. Stripe is not configured here — it connects through OAuth, and Markii " +
    "never accepts a merchant's secret key.",
  input: z
    .object({
      rail: railSchema,
      config: z.record(z.string(), z.string()),
    })
    .strict(),
  /**
   * **`billing.write` — owner and administrator only.** Deliberately not
   * `catalog.write` and not `cms.write`: `developer` holds the latter and its
   * role comment already says "no authority over money", which is exactly the
   * line this respects.
   */
  permission: "billing.write",
  /** Changing where revenue is paid. Nothing in this codebase outranks it. */
  riskTier: "high",
  requiresStepUp: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;

    if (input.rail === "stripe") {
      throw badRequest(
        "Stripe is connected through Connect Standard OAuth, not by supplying a key. Markii never " +
          "stores a merchant secret key — you keep your own Stripe account, rates, dashboard, and " +
          "payouts. Connect it from the Payments settings.",
      );
    }

    const config = railConfigSchemas[input.rail].parse(input.config);
    const existing = await getIntegration(orgId, input.rail);

    /**
     * The diff anyone investigating a redirected payout looks for first: the old
     * and new destination, with an actor and a timestamp on the invocation.
     */
    ctx.recordDiff({
      entity: "paymentRail",
      entityId: `${orgId}:${input.rail}`,
      path: "walletAddress",
      before: existing?.config.walletAddress ?? null,
      after: config.walletAddress,
    });

    const row = await upsertIntegration(orgId, input.rail, "connected", {
      ...existing?.config,
      ...config,
    });
    return integrationStatus(input.rail, row);
  },
});

export const disconnectRail = defineAction({
  id: "payments.disconnectRail",
  description:
    "Stop accepting payments on a rail. For x402 this removes the wallet revenue is paid to, so " +
    "the store can no longer take payment that way.",
  input: z.object({ rail: railSchema }).strict(),
  permission: "billing.write",
  /** Turning a rail off stops money arriving — the same decision reversed. */
  riskTier: "high",
  requiresStepUp: true,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;

    const existing = await getIntegration(orgId, input.rail);
    ctx.recordDiff({
      entity: "paymentRail",
      entityId: `${orgId}:${input.rail}`,
      path: "status",
      before: existing?.status ?? null,
      after: "not_connected",
    });

    /**
     * Config is cleared rather than kept. A disconnected rail still holding a
     * wallet address would quietly resume paying an old destination if it were
     * ever reconnected without a new one being supplied.
     */
    const row = await upsertIntegration(orgId, input.rail, "not_connected", {});
    return integrationStatus(input.rail, row);
  },
});
