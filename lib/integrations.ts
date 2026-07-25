import { eq } from "drizzle-orm";
import { db, integrations, type Integration } from "@/lib/db";

export type Provider = "x402" | "google" | "stripe";
export const PROVIDERS: Provider[] = ["x402", "google", "stripe"];

export async function getIntegration(provider: Provider): Promise<Integration | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.provider, provider))
    .limit(1);
  return row ?? null;
}

export async function upsertIntegration(
  provider: Provider,
  status: Integration["status"],
  config: Record<string, string>,
  message: string | null = null,
): Promise<Integration> {
  const [row] = await db
    .insert(integrations)
    .values({ provider, status, config, message, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: integrations.provider,
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

/** Default x402 receiving wallet for sites that don't set their own. */
export async function defaultWallet(): Promise<string | null> {
  const row = await getIntegration("x402");
  return row?.config.walletAddress ?? null;
}
