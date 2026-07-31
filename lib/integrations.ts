import { and, eq } from "drizzle-orm";
import { newId } from "@/lib/auth/provisioning";
import { db, integrations, type Integration } from "@/lib/db";
import type { OrgId } from "@/lib/tenancy";

export type Provider = "x402" | "google" | "stripe";
export const PROVIDERS: Provider[] = ["x402", "google", "stripe"];

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
      return {
        ...base,
        accountId: row?.config.secretKey ? `sk_…${row.config.secretKey.slice(-4)}` : null,
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
