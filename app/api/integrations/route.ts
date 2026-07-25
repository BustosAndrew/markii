import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { getIntegration, integrationStatus, PROVIDERS } from "@/lib/integrations";

export const GET = handler(async () => {
  const entries = await Promise.all(
    PROVIDERS.map(async (p) => [p, integrationStatus(p, await getIntegration(p))] as const),
  );
  return NextResponse.json(Object.fromEntries(entries));
});
