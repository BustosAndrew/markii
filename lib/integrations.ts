import { and, eq } from "drizzle-orm";
import { newId } from "@/lib/auth/provisioning";
import { db, integrations, type Integration } from "@/lib/db";
import type { OrgId } from "@/lib/tenancy";

export type Provider = "x402" | "google" | "stripe";
export const PROVIDERS: Provider[] = ["x402", "google", "stripe"];

/**
 * Providers split by **what they can cost a merchant if they go wrong**, and the
 * split is an authority boundary rather than navigation.
 *
 * A payment rail decides where money is paid: changing the x402 wallet address
 * redirects revenue, and turning a rail off stops it arriving. A catalog feed
 * publishes products to a shopping surface — worth getting right, but nobody
 * loses money if a `catalog_manager` reconnects it.
 *
 * They were one group until 2026-08-08, which meant connecting Google Merchant
 * Center required `billing.write` **and** a fresh MFA challenge, because those
 * were the right rules for the wallet address sitting next to it. Same table,
 * same route, very different stakes.
 */
export const PAYMENT_RAILS = ["x402", "stripe"] as const;
export const CATALOG_FEEDS = ["google"] as const;

export type PaymentRail = (typeof PAYMENT_RAILS)[number];
export type CatalogFeed = (typeof CATALOG_FEEDS)[number];

export function isPaymentRail(provider: Provider): provider is PaymentRail {
  return (PAYMENT_RAILS as readonly Provider[]).includes(provider);
}

/**
 * Integration credentials are **per organization**. `provider` used to be the
 * primary key, which made the table silently single-tenant: the second org to
 * connect Stripe would have overwritten the first one's secret key.
 *
 * `orgId` is required on both accessors for the same reason the query helpers
 * in `lib/tenancy.ts` require it — there is no unscoped variant to reach for.
 */
export async function getIntegration(
  orgId: OrgId,
  provider: Provider,
): Promise<Integration | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.provider, provider)))
    .limit(1);
  return row ?? null;
}

export async function upsertIntegration(
  orgId: OrgId,
  provider: Provider,
  status: Integration["status"],
  config: Record<string, string>,
  message: string | null = null,
): Promise<Integration> {
  const [row] = await db
    .insert(integrations)
    .values({ id: newId("int"), orgId, provider, status, config, message, updatedAt: new Date() })
    .onConflictDoUpdate({
      // Matches the (org_id, provider) unique index, so one org reconnecting a
      // provider updates its own row and never another tenant's.
      target: [integrations.orgId, integrations.provider],
      set: { status, config, message, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** Public (secret-free) status object per provider, as the contract specifies. */
export function integrationStatus(provider: Provider, row: Integration | null) {
  const status = row?.status ?? "not_connected";
  const base = { status, ...(row?.message ? { message: row.message } : {}) };
  switch (provider) {
    case "x402":
      return { ...base, walletAddress: row?.config.walletAddress ?? null, network: "base-sepolia" };
    case "google":
      return {
        ...base,
        merchantId: row?.config.merchantId ?? null,
        lastSyncAt: row?.config.lastSyncAt ?? null,
      };
    case "stripe":
      /**
       * **Connect Standard, so there is no merchant secret to report** (D4).
       * The merchant keeps their own Stripe account, dashboard, rates, and
       * payouts; Markii holds a revocable connection to it and creates charges
       * with `Stripe-Account`. This previously returned `sk_…1234` under the
       * key `accountId` — mislabelling a secret key as an account id and
       * leaking its last four characters into every dashboard response.
       *
       * `chargesEnabled` is the only honest gate for offering the card rail:
       * an account can be connected and still unable to take payments while
       * Stripe is waiting on the merchant's verification documents.
       */
      return {
        ...base,
        mode: "connect_standard" as const,
        accountId: row?.config.accountId ?? null,
        chargesEnabled: row?.config.chargesEnabled === "true",
        payoutsEnabled: row?.config.payoutsEnabled === "true",
        connectedAt: row?.config.connectedAt ?? null,
        /** Stripe's own outstanding requirements, when it has told us of any. */
        requirementsDue: row?.config.requirementsDue
          ? row.config.requirementsDue.split(",").filter(Boolean)
          : [],
      };
  }
}

/**
 * Default x402 receiving wallet for sites that don't set their own.
 *
 * Storefronts are public and have no session, so the org comes from the site
 * row. `null` is accepted because `sites.orgId` is nullable until the backfill
 * completes — an unassigned site simply has no default wallet, rather than
 * falling back to some other tenant's.
 */
export async function defaultWallet(orgId: OrgId | null): Promise<string | null> {
  if (!orgId) return null;
  const row = await getIntegration(orgId, "x402");
  return row?.config.walletAddress ?? null;
}
