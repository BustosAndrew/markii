import { z } from "zod";
import { badRequest, notFound } from "../../api";
import {
  getIntegration,
  integrationStatus,
  upsertIntegration,
  CATALOG_FEEDS,
  type CatalogFeed,
} from "../../integrations";
import { defineAction } from "../registry";

/**
 * Catalog feeds — publishing products to an outside shopping surface (§8).
 *
 * **Payment rails moved out on 2026-08-08** (`definitions/payments.ts`). Until
 * then one action covered both, so the rules had to be sized for the riskier
 * member: connecting Google Merchant Center required `billing.write` and a fresh
 * MFA step-up, because the x402 wallet address shared the same code path. That
 * made a routine catalog task need the authority to move money.
 *
 * These now sit at the authority a product feed actually warrants. Getting one
 * wrong publishes bad listings, which is fixed by fixing them — nobody's revenue
 * goes anywhere else.
 *
 * The history is worth keeping because the original grouping was reasonable:
 * they are all rows in `integrations`, all "connect an outside service". Storage
 * shape is not authority, and that is the mistake worth not repeating.
 */

const feedSchema = z.enum(CATALOG_FEEDS);

const feedConfigSchemas: Record<CatalogFeed, z.ZodType<Record<string, string>>> = {
  google: z
    .object({
      merchantId: z.string().min(1).max(64).optional(),
      serviceAccountJson: z.string().min(2),
    })
    .strict()
    .transform((v) => ({ ...v })) as z.ZodType<Record<string, string>>,
};

export const connectIntegration = defineAction({
  id: "integrations.connect",
  description:
    "Connect or update a catalog feed, so products publish to an outside shopping surface. " +
    "Payment rails are configured separately — see payments.connectRail.",
  input: z
    .object({
      provider: feedSchema,
      config: z.record(z.string(), z.string()),
    })
    .strict(),
  /**
   * **`catalog.write`, not `billing.write`.** A product feed is catalog work, so
   * a `catalog_manager` — whose whole role is the catalog — can do it without
   * being handed authority over the merchant's money.
   */
  permission: "catalog.write",
  /**
   * Medium, not high: a bad feed publishes wrong listings, which is corrected by
   * correcting them. No step-up — demanding a second factor to reconnect a
   * product feed trains people to treat the prompt as noise, which is how a
   * step-up on something that *does* move money gets clicked through.
   */
  riskTier: "medium",
  /**
   * The service-account JSON is a credential, and the audit row is long-lived
   * and widely readable.
   */
  redactInput: (input) => ({
    provider: input.provider,
    config: { ...input.config, serviceAccountJson: "[redacted]" },
  }),
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;

    const config = feedConfigSchemas[input.provider].parse(input.config);
    try {
      JSON.parse(config.serviceAccountJson);
    } catch {
      throw badRequest("serviceAccountJson is not valid JSON");
    }

    const existing = await getIntegration(orgId, input.provider);
    ctx.recordDiff({
      entity: "catalogFeed",
      entityId: `${orgId}:${input.provider}`,
      path: "status",
      before: existing?.status ?? null,
      after: "connected",
    });

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
    "Disconnect a catalog feed. Products stop publishing to that surface; nothing about payments " +
    "changes.",
  input: z.object({ provider: feedSchema }).strict(),
  permission: "catalog.write",
  riskTier: "medium",
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Organization");
    const orgId = ctx.actor.orgId;

    const existing = await getIntegration(orgId, input.provider);
    ctx.recordDiff({
      entity: "catalogFeed",
      entityId: `${orgId}:${input.provider}`,
      path: "status",
      before: existing?.status ?? null,
      after: "not_connected",
    });

    /** Clears the stored credential rather than leaving it dormant on the row. */
    const row = await upsertIntegration(orgId, input.provider, "not_connected", {});
    return integrationStatus(input.provider, row);
  },
});
