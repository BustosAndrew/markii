import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { getIntegration, integrationStatus, PROVIDERS } from "@/lib/integrations";

export const GET = orgHandler(async (_req, { orgId }) => {
  const entries = await Promise.all(
    PROVIDERS.map(async (p) => [p, integrationStatus(p, await getIntegration(orgId, p))] as const),
  );
  return NextResponse.json(Object.fromEntries(entries));
});
