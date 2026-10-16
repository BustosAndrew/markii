import { NextResponse } from "next/server";
import { unauthorized } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { AGENT_DIRECTORY } from "@/lib/ops-agents";
import { isModelConfigured } from "@/lib/ops-agents/config";
import { mockModelEnabled } from "@/lib/ops-agents/mock-model";
import { allowanceForOrg } from "@/lib/ops-agents/usage";

/**
 * `GET /api/agents` — the merchant agents, whether they can run here, and the
 * org's beta allowance (D47).
 *
 * `configured` and `allowance.allowed` are separate facts with separate owners
 * — Markii's deployment, and this org's month — and a screen must not merge
 * them into one "available".
 */
export const GET = orgHandler(async (_req, { orgId, session }) => {
  if (!session.user) throw unauthorized("Merchant agents are used from the dashboard.");

  return NextResponse.json({
    agents: Object.entries(AGENT_DIRECTORY).map(([id, a]) => ({ id, ...a })),
    configured: isModelConfigured() || mockModelEnabled(),
    allowance: await allowanceForOrg(orgId),
  });
});
