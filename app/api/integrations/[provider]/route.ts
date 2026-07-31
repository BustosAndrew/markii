import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
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
  stripe: z.object({ secretKey: z.string().startsWith("sk_") }),
};

function parseProvider(raw: string): Provider {
  if (raw !== "x402" && raw !== "google" && raw !== "stripe")
    throw badRequest(`unknown provider "${raw}" (expected x402, google or stripe)`);
  return raw;
}

export const PUT = orgHandler(async (req, { params, orgId }) => {
  const provider = parseProvider((await params).provider);
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

export const DELETE = orgHandler(async (_req, { params, orgId }) => {
  const provider = parseProvider((await params).provider);
  const row = await upsertIntegration(orgId, provider, "not_connected", {});
  return NextResponse.json(integrationStatus(provider, row));
});
